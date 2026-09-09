import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as contracts from "../harness/history-schemas.js";
import { captureHistory as capture, captureHistoryMetadata } from "../harness/history-capture.js";
import {
  agentOpsHome,
  historyArtifactsPath,
  historyDatabasePath,
  historyDirectory
} from "../workspaces/storage.js";
import {
  artifacts,
  deliveryAttempts,
  interactions,
  messages,
  modelCalls,
  runs,
  toolCalls
} from "./schema.js";

const HISTORY_SCHEMA_VERSION = 1;
const processOwner: contracts.HistoryOwner = {
  token: crypto.randomUUID(),
  pid: process.pid,
  host: os.hostname()
};
const now = () => new Date().toISOString();

export interface HistoryOpenOptions {
  home?: string;
  busyTimeoutMs?: number;
}
export interface HistoryStoreOptions extends HistoryOpenOptions {
  owner?: contracts.HistoryOwner;
}
export interface AcceptedInteraction {
  claimed: boolean;
  interactionId: string;
  runId: number;
  messageId: number;
}

function metadata(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = captureHistoryMetadata(value);
  if (safe.incomplete || Buffer.byteLength(safe.text) > 2048)
    throw new Error("Invalid history metadata");
  return safe.text;
}

function assertNoSymlink(file: string): void {
  let current = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("History paths must not contain symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function databaseVersion(sqlite: Database.Database): number {
  return Number(sqlite.pragma("user_version", { simple: true }));
}

function verifySchema(sqlite: Database.Database): void {
  if (databaseVersion(sqlite) !== HISTORY_SCHEMA_VERSION)
    throw new Error("Unsupported history schema version");
  // Preparing the projections rejects missing/legacy tables and columns without touching records.
  const db = drizzle(sqlite);
  for (const table of [
    interactions,
    runs,
    messages,
    toolCalls,
    modelCalls,
    artifacts,
    deliveryAttempts
  ])
    db.select().from(table).limit(0).all();
}

function openConnection(
  options: HistoryOpenOptions,
  readonly: boolean
): Database.Database | undefined {
  const home = path.resolve(options.home ?? agentOpsHome());
  const file = historyDatabasePath(home);
  const timeout = options.busyTimeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 10000)
    throw new Error("Invalid history busy timeout");
  // Resolve the explicitly configured root once (macOS /var is a standard symlink).
  let ancestor = home;
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor))
    ancestor = path.dirname(ancestor);
  const root = path.join(fs.realpathSync(ancestor), path.relative(ancestor, home));
  const resolvedFile = historyDatabasePath(root);
  assertNoSymlink(path.dirname(resolvedFile));
  assertNoSymlink(resolvedFile);
  for (const suffix of ["-wal", "-shm", "-journal"]) assertNoSymlink(resolvedFile + suffix);
  if (readonly) {
    try {
      fs.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  } else {
    fs.mkdirSync(historyDirectory(root), { recursive: true, mode: 0o700 });
    fs.chmodSync(historyDirectory(root), 0o700);
    assertNoSymlink(historyArtifactsPath(root));
    fs.mkdirSync(historyArtifactsPath(root), { mode: 0o700, recursive: true });
    fs.chmodSync(historyArtifactsPath(root), 0o700);
    const fd = fs.openSync(
      resolvedFile,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.closeSync(fd);
    fs.chmodSync(resolvedFile, 0o600);
  }
  const sqlite = new Database(resolvedFile, { readonly, fileMustExist: true, timeout });
  try {
    sqlite.pragma("foreign_keys = ON");
    if (readonly) {
      sqlite.pragma("query_only = ON");
      verifySchema(sqlite);
      return sqlite;
    }
    const version = databaseVersion(sqlite);
    if (version !== 0 && version !== HISTORY_SCHEMA_VERSION)
      throw new Error("Unsupported history schema version");
    if (
      version === 0 &&
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
    )
      throw new Error("Unsupported unversioned history schema");
    const runtime = sqlite.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    const [major = 0, minor = 0, patch = 0] = runtime.version.split(".").map(Number);
    // https://www.sqlite.org/wal.html#walreset: 3.51.3+, with 3.44.6 / 3.50.7 backports.
    const walSafe =
      major > 3 ||
      (major === 3 &&
        (minor > 51 ||
          (minor === 51 && patch >= 3) ||
          (minor === 50 && patch >= 7) ||
          (minor === 44 && patch >= 6)));
    if (!walSafe) throw new Error("SQLite runtime lacks the WAL-reset fix");
    if (sqlite.pragma("journal_mode = WAL", { simple: true }) !== "wal")
      throw new Error("History WAL initialization failed");
    sqlite.pragma("synchronous = FULL");
    sqlite
      .transaction(() => {
        if (databaseVersion(sqlite) === 0) {
          sqlite.exec(bootstrapSql);
          sqlite.pragma(`user_version = ${HISTORY_SCHEMA_VERSION}`);
        }
        verifySchema(sqlite);
      })
      .immediate();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(resolvedFile + suffix)) fs.chmodSync(resolvedFile + suffix, 0o600);
    }
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

const pageLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("History page limit must be 1..100");
  return limit;
};

class HistoryReader {
  protected readonly db;
  constructor(protected readonly sqlite: Database.Database) {
    this.db = drizzle(sqlite);
  }
  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }
  getInteraction(id: string) {
    const row = this.db.select().from(interactions).where(eq(interactions.id, id)).get();
    return row ? contracts.parseHistory(contracts.InteractionRecordSchema, row) : undefined;
  }
  getRun(id: number) {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? contracts.parseHistory(contracts.RunRecordSchema, row) : undefined;
  }
  listInteractions(limit = 20) {
    return this.db
      .select()
      .from(interactions)
      .orderBy(desc(interactions.startedAt), desc(interactions.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.InteractionRecordSchema, row));
  }
  listRuns(interactionId: string, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.interactionId, interactionId), gt(runs.id, afterId)))
      .orderBy(asc(runs.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.RunRecordSchema, row));
  }
  listMessages(interactionId: string, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.interactionId, interactionId), gt(messages.id, afterId)))
      .orderBy(asc(messages.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.MessageRecordSchema, row));
  }
  listToolCalls(runId: number, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, runId), gt(toolCalls.id, afterId)))
      .orderBy(asc(toolCalls.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.ToolCallRecordSchema, row));
  }
  listModelCalls(runId: number, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(modelCalls)
      .where(and(eq(modelCalls.runId, runId), gt(modelCalls.id, afterId)))
      .orderBy(asc(modelCalls.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.ModelCallRecordSchema, row));
  }
  listArtifacts(interactionId: string, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.interactionId, interactionId), gt(artifacts.id, afterId)))
      .orderBy(asc(artifacts.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.ArtifactRecordSchema, row));
  }
  listDeliveryAttempts(messageId: number, limit = 50, afterId = 0) {
    return this.db
      .select()
      .from(deliveryAttempts)
      .where(and(eq(deliveryAttempts.messageId, messageId), gt(deliveryAttempts.id, afterId)))
      .orderBy(asc(deliveryAttempts.id))
      .limit(pageLimit(limit))
      .all()
      .map((row) => contracts.parseHistory(contracts.DeliveryAttemptRecordSchema, row));
  }
}

export class HistoryStore extends HistoryReader {
  constructor(
    sqlite: Database.Database,
    readonly owner: Readonly<contracts.HistoryOwner>,
    private readonly home: string
  ) {
    super(sqlite);
  }
  private write<T>(operation: () => T): T {
    return this.sqlite.transaction(operation).immediate();
  }
  private owned(interactionId: string, running = true): void {
    const interaction = this.getInteraction(interactionId);
    if (
      !interaction ||
      interaction.ownerToken !== this.owner.token ||
      (running && interaction.status !== "running")
    )
      throw new Error("History execution is not owned and active");
  }
  private ownedRun(runId: number, running = true) {
    const run = this.getRun(runId);
    if (!run || (running && run.status !== "running")) throw new Error("History run is not active");
    this.owned(run.interactionId, running);
    return run;
  }
  private observed(interactionId: string, envelope: contracts.CaptureEnvelope): void {
    if (envelope.incomplete)
      this.db
        .update(interactions)
        .set({ incomplete: true })
        .where(and(eq(interactions.id, interactionId), eq(interactions.incomplete, false)))
        .run();
  }
  acceptInteraction(input: contracts.AcceptInteractionInput): AcceptedInteraction {
    const p = contracts.parseHistory(contracts.AcceptInteractionSchema, input);
    if (
      p.source === "discord"
        ? !p.applicationId || !p.sourceMessageId
        : p.applicationId !== undefined || p.sourceMessageId !== undefined
    )
      throw new Error("Invalid history source identity");
    const applicationId = metadata(p.applicationId),
      sourceMessageId = metadata(p.sourceMessageId);
    if (applicationId !== p.applicationId || sourceMessageId !== p.sourceMessageId)
      throw new Error("Unsafe history source identity");
    const content = capture(p.userMessage),
      meta = captureHistoryMetadata(p.metadata ?? {});
    return this.write(() => {
      if (p.source === "discord") {
        const existing = this.db
          .select()
          .from(interactions)
          .where(
            and(
              eq(interactions.source, p.source),
              eq(interactions.applicationId, applicationId!),
              eq(interactions.sourceMessageId, sourceMessageId!)
            )
          )
          .get();
        if (existing) {
          const run = this.db
            .select()
            .from(runs)
            .where(and(eq(runs.interactionId, existing.id), isNull(runs.parentRunId)))
            .get();
          const message = this.db
            .select()
            .from(messages)
            .where(and(eq(messages.interactionId, existing.id), eq(messages.sequence, 1)))
            .get();
          if (!run || !message) throw new Error("Incomplete history acceptance");
          return {
            claimed: false,
            interactionId: existing.id,
            runId: run.id,
            messageId: message.id
          };
        }
      }
      const interactionId = crypto.randomUUID(),
        startedAt = now();
      this.db
        .insert(interactions)
        .values({
          id: interactionId,
          source: p.source,
          applicationId,
          sourceMessageId,
          conversationKey: metadata(p.conversationKey),
          target: metadata(p.target),
          ownerToken: this.owner.token,
          ownerPid: this.owner.pid,
          ownerHost: this.owner.host,
          incomplete: content.incomplete || meta.incomplete,
          metadata: meta,
          startedAt
        })
        .run();
      const run = this.db
        .insert(runs)
        .values({
          interactionId,
          kind: metadata(p.kind)!,
          target: metadata(p.target),
          metadata: meta,
          startedAt
        })
        .returning()
        .get();
      const message = this.db
        .insert(messages)
        .values({
          interactionId,
          runId: run.id,
          sequence: 1,
          role: "user",
          content,
          createdAt: startedAt
        })
        .returning()
        .get();
      return { claimed: true, interactionId, runId: run.id, messageId: message.id };
    });
  }
  createRun(input: contracts.CreateRunInput): number {
    const p = contracts.parseHistory(contracts.CreateRunSchema, input),
      meta = captureHistoryMetadata(p.metadata ?? {});
    return this.write(() => {
      const parent = this.ownedRun(p.parentRunId);
      if (parent.interactionId !== p.interactionId) throw new Error("Cross-interaction parent run");
      if (p.triggeringToolCallId !== undefined) {
        const trigger = this.db
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, p.triggeringToolCallId))
          .get();
        if (!trigger || trigger.runId !== p.parentRunId || trigger.status !== "running")
          throw new Error("Invalid triggering tool call");
      }
      this.observed(p.interactionId, meta);
      return this.db
        .insert(runs)
        .values({
          interactionId: p.interactionId,
          parentRunId: p.parentRunId,
          triggeringToolCallId: p.triggeringToolCallId,
          kind: metadata(p.kind)!,
          target: metadata(p.target),
          ref: metadata(p.ref),
          commitSha: metadata(p.commitSha),
          metadata: meta,
          startedAt: now()
        })
        .returning()
        .get().id;
    });
  }
  startToolCall(input: contracts.StartToolCallInput): number {
    const p = contracts.parseHistory(contracts.StartToolCallSchema, input),
      content = capture(p.input);
    return this.write(() => {
      const run = this.ownedRun(p.runId);
      if (p.parentCallId !== undefined) {
        const parent = this.db
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.id, p.parentCallId))
          .get();
        if (!parent || this.ownedRun(parent.runId).interactionId !== run.interactionId)
          throw new Error("Cross-interaction parent call");
      }
      const existing = this.db
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, p.runId), eq(toolCalls.ordinal, p.ordinal)))
        .get();
      if (existing) return existing.id;
      this.observed(run.interactionId, content);
      return this.db
        .insert(toolCalls)
        .values({
          runId: p.runId,
          ordinal: p.ordinal,
          parentCallId: p.parentCallId,
          providerCallId: metadata(p.providerCallId),
          source: metadata(p.source),
          name: metadata(p.name)!,
          kind: p.kind,
          input: content,
          startedAt: now()
        })
        .returning()
        .get().id;
    });
  }
  updateRun(input: contracts.UpdateRunInput): boolean {
    const p = contracts.parseHistory(contracts.UpdateRunSchema, input);
    return this.write(() => {
      if (!this.canFinish("run", p.id)) return false;
      const meta = p.metadata === undefined ? undefined : captureHistoryMetadata(p.metadata);
      if (meta) this.observed(this.getRun(p.id)!.interactionId, meta);
      const values = {
        target: metadata(p.target),
        ref: metadata(p.ref),
        commitSha: metadata(p.commitSha),
        metadata: meta
      };
      if (Object.values(values).every((value) => value === undefined)) return true;
      return (
        this.db
          .update(runs)
          .set(values)
          .where(and(eq(runs.id, p.id), eq(runs.status, "running")))
          .run().changes === 1
      );
    });
  }
  finishToolCall(input: contracts.FinishToolCallInput): boolean {
    const p = contracts.parseHistory(contracts.FinishToolCallSchema, input);
    return this.write(() => {
      if (!this.canFinish("tool_call", p.id)) return false;
      const result = p.result === undefined ? null : capture(p.result),
        error = p.error === undefined ? null : capture(p.error);
      const call = this.db.select().from(toolCalls).where(eq(toolCalls.id, p.id)).get()!;
      for (const envelope of [result, error])
        if (envelope) this.observed(this.getRun(call.runId)!.interactionId, envelope);
      return (
        this.db
          .update(toolCalls)
          .set({ status: p.status, result, error, finishedAt: now() })
          .where(and(eq(toolCalls.id, p.id), eq(toolCalls.status, "running")))
          .run().changes === 1
      );
    });
  }
  startModelCall(input: contracts.StartModelCallInput): number {
    const p = contracts.parseHistory(contracts.StartModelCallSchema, input);
    return this.write(() => {
      this.ownedRun(p.runId);
      const existing = this.db
        .select()
        .from(modelCalls)
        .where(and(eq(modelCalls.runId, p.runId), eq(modelCalls.ordinal, p.ordinal)))
        .get();
      if (existing) return existing.id;
      return this.db
        .insert(modelCalls)
        .values({
          ...p,
          provider: metadata(p.provider)!,
          model: metadata(p.model)!,
          startedAt: now()
        })
        .returning()
        .get().id;
    });
  }
  finishModelCall(input: contracts.FinishModelCallInput): boolean {
    const p = contracts.parseHistory(contracts.FinishModelCallSchema, input);
    return this.write(() => {
      if (!this.canFinish("model_call", p.id)) return false;
      return (
        this.db
          .update(modelCalls)
          .set({
            status: p.status,
            error: p.error === undefined ? null : capture(p.error),
            finishedAt: now(),
            usageState: p.usage ? "known" : "unknown",
            inputTokens: p.usage?.inputTokens ?? null,
            outputTokens: p.usage?.outputTokens ?? null,
            totalTokens: p.usage
              ? (p.usage.totalTokens ?? p.usage.inputTokens + p.usage.outputTokens)
              : null
          })
          .where(and(eq(modelCalls.id, p.id), eq(modelCalls.status, "running")))
          .run().changes === 1
      );
    });
  }
  appendMessage(input: contracts.AppendMessageInput): number {
    const p = contracts.parseHistory(contracts.AppendMessageSchema, input),
      content = capture(p.content);
    return this.write(() => {
      this.owned(p.interactionId);
      if (p.runId !== undefined && this.ownedRun(p.runId, false).interactionId !== p.interactionId)
        throw new Error("Cross-interaction message");
      const sequence = this.db
        .select({ n: sql<number>`coalesce(max(${messages.sequence}), 0) + 1` })
        .from(messages)
        .where(eq(messages.interactionId, p.interactionId))
        .get()!.n;
      this.observed(p.interactionId, content);
      return this.db
        .insert(messages)
        .values({
          interactionId: p.interactionId,
          runId: p.runId,
          role: p.role,
          content,
          sequence,
          createdAt: now()
        })
        .returning()
        .get().id;
    });
  }
  registerArtifact(input: contracts.RegisterArtifactInput): number {
    const p = contracts.parseHistory(contracts.RegisterArtifactSchema, input);
    const root = fs.realpathSync(historyArtifactsPath(this.home)),
      file = path.resolve(p.path);
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative.startsWith(".." + path.sep) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("Artifact is outside history artifacts");
    assertNoSymlink(file);
    if (metadata(file) !== file) throw new Error("Unsafe artifact path");
    let availability: "available" | "missing" = "missing";
    try {
      if (!fs.statSync(file).isFile()) throw new Error("Artifact is not a file");
      availability = "available";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.write(() => {
      this.owned(p.interactionId);
      if (p.runId !== undefined && this.ownedRun(p.runId).interactionId !== p.interactionId)
        throw new Error("Cross-interaction artifact");
      return this.db
        .insert(artifacts)
        .values({
          interactionId: p.interactionId,
          runId: p.runId,
          path: file,
          type: metadata(p.type)!,
          title: metadata(p.title),
          availability,
          createdAt: now()
        })
        .returning()
        .get().id;
    });
  }
  startDeliveryAttempt(input: contracts.StartDeliveryAttemptInput): number {
    const p = contracts.parseHistory(contracts.StartDeliveryAttemptSchema, input);
    return this.write(() => {
      const message = this.db.select().from(messages).where(eq(messages.id, p.messageId)).get();
      if (!message) throw new Error("Unknown history message");
      this.owned(message.interactionId, false);
      const existing = this.db
        .select()
        .from(deliveryAttempts)
        .where(
          and(
            eq(deliveryAttempts.messageId, p.messageId),
            eq(deliveryAttempts.part, p.part),
            eq(deliveryAttempts.attempt, p.attempt)
          )
        )
        .get();
      if (existing) return existing.id;
      return this.db
        .insert(deliveryAttempts)
        .values({ ...p, startedAt: now() })
        .returning()
        .get().id;
    });
  }
  finishDeliveryAttempt(input: contracts.FinishDeliveryAttemptInput): boolean {
    const p = contracts.parseHistory(contracts.FinishDeliveryAttemptSchema, input);
    if (p.status === "acknowledged" && !p.surfaceMessageId)
      throw new Error("Acknowledged delivery requires a surface message ID");
    return this.write(() => {
      const row = this.sqlite
        .prepare(
          "SELECT d.id FROM delivery_attempt d JOIN message m ON m.id=d.message_id JOIN interaction i ON i.id=m.interaction_id WHERE d.id=? AND d.status='pending' AND i.owner_token=?"
        )
        .get(p.id, this.owner.token);
      if (!row) return false;
      return (
        this.db
          .update(deliveryAttempts)
          .set({
            status: p.status,
            surfaceMessageId: metadata(p.surfaceMessageId),
            error: p.error === undefined ? null : capture(p.error),
            finishedAt: now()
          })
          .where(and(eq(deliveryAttempts.id, p.id), eq(deliveryAttempts.status, "pending")))
          .run().changes === 1
      );
    });
  }
  private canFinish(table: "run" | "tool_call" | "model_call", id: number): boolean {
    const joins =
      table === "run"
        ? "JOIN interaction i ON i.id=t.interaction_id"
        : "JOIN run r ON r.id=t.run_id JOIN interaction i ON i.id=r.interaction_id";
    return !!this.sqlite
      .prepare(
        `SELECT t.id FROM ${table} t ${joins} WHERE t.id=? AND t.status='running' AND i.status='running' AND i.owner_token=? ${table === "run" ? "" : "AND r.status='running'"}`
      )
      .get(id, this.owner.token);
  }
  finishRun(input: contracts.FinishRunInput): boolean {
    const p = contracts.parseHistory(contracts.FinishRunSchema, input);
    return this.write(() => {
      if (!this.canFinish("run", p.id)) return false;
      const endedAt = now(),
        failure = p.error === undefined ? null : capture(p.error);
      const changed =
        this.db
          .update(runs)
          .set({
            status: p.status,
            finishedAt: endedAt,
            error: failure
          })
          .where(and(eq(runs.id, p.id), eq(runs.status, "running")))
          .run().changes === 1;
      // A terminal workflow cannot leave its unobserved calls/descendants running forever.
      // Completed child records retain their own outcomes, independently of this run.
      const subtree =
        "WITH RECURSIVE subtree(id) AS (SELECT id FROM run WHERE id=? UNION ALL SELECT r.id FROM run r JOIN subtree s ON r.parent_run_id=s.id)";
      const unfinishedStatus = p.status === "completed" ? "interrupted" : p.status;
      let unfinished = 0;
      for (const table of ["tool_call", "model_call", "run"])
        unfinished += this.sqlite
          .prepare(
            `${subtree} UPDATE ${table} SET status=?, finished_at=?, error=? WHERE status='running' AND ${table === "run" ? "id" : "run_id"} IN (SELECT id FROM subtree)`
          )
          .run(
            p.id,
            unfinishedStatus,
            endedAt,
            failure === null ? null : JSON.stringify(failure)
          ).changes;
      if (unfinished || failure?.incomplete)
        this.db
          .update(interactions)
          .set({ incomplete: true })
          .where(eq(interactions.id, this.getRun(p.id)!.interactionId))
          .run();
      return changed;
    });
  }
  finishInteraction(input: contracts.FinishInteractionInput): boolean {
    const p = contracts.parseHistory(contracts.FinishInteractionSchema, input);
    return this.write(() =>
      this.terminalInteraction(p.id, p.status, p.error, p.incomplete ?? false, this.owner.token)
    );
  }
  abortUnfinished(input: contracts.AbortUnfinishedInput): boolean {
    const p = contracts.parseHistory(contracts.AbortUnfinishedSchema, input);
    return this.write(() => {
      const changed = this.terminalInteraction(
        p.interactionId,
        "failed",
        p.error ?? "recording_failure",
        true,
        this.owner.token
      );
      // Delivery recording can fail after execution completed. Preserve that outcome while
      // making the incomplete capture and any unacknowledged sends visible to this owner.
      const marked = this.db
        .update(interactions)
        .set({ incomplete: true })
        .where(
          and(
            eq(interactions.id, p.interactionId),
            eq(interactions.ownerToken, this.owner.token),
            eq(interactions.incomplete, false)
          )
        )
        .run().changes;
      const delivery = this.uncertainDeliveries(p.interactionId, this.owner.token);
      return changed || marked > 0 || delivery > 0;
    });
  }
  private terminalInteraction(
    id: string,
    status: contracts.TerminalStatus,
    error: unknown,
    incomplete: boolean,
    ownerToken: string
  ): boolean {
    const endedAt = now(),
      failure = error === undefined ? null : capture(error);
    const changed = this.db
      .update(interactions)
      .set({
        status,
        finishedAt: endedAt,
        error: failure,
        incomplete: sql`${interactions.incomplete} OR ${Number(incomplete || status === "interrupted" || (failure?.incomplete ?? false))}`
      })
      .where(
        and(
          eq(interactions.id, id),
          eq(interactions.status, "running"),
          eq(interactions.ownerToken, ownerToken)
        )
      )
      .run().changes;
    if (!changed) return false;
    // Unobserved children/calls never acquire a fabricated success from their parent.
    const unfinishedStatus = status === "completed" ? "interrupted" : status;
    let unfinished = 0;
    for (const table of ["tool_call", "model_call"])
      unfinished += this.sqlite
        .prepare(
          `UPDATE ${table} SET status=?, finished_at=?, error=? WHERE status='running' AND run_id IN (SELECT id FROM run WHERE interaction_id=?)`
        )
        .run(
          unfinishedStatus,
          endedAt,
          failure === null ? null : JSON.stringify(failure),
          id
        ).changes;
    unfinished += this.sqlite
      .prepare(
        "UPDATE run SET status=?, finished_at=?, error=? WHERE status='running' AND parent_run_id IS NOT NULL AND interaction_id=?"
      )
      .run(
        unfinishedStatus,
        endedAt,
        failure === null ? null : JSON.stringify(failure),
        id
      ).changes;
    this.db
      .update(runs)
      .set({ status, finishedAt: endedAt, error: failure })
      .where(and(eq(runs.interactionId, id), isNull(runs.parentRunId), eq(runs.status, "running")))
      .run();
    if (unfinished)
      this.db.update(interactions).set({ incomplete: true }).where(eq(interactions.id, id)).run();
    return true;
  }
  private uncertainDeliveries(interactionId: string, token: string): number {
    return this.sqlite
      .prepare(
        "UPDATE delivery_attempt SET status='uncertain', finished_at=? WHERE status='pending' AND message_id IN (SELECT m.id FROM message m JOIN interaction i ON i.id=m.interaction_id WHERE i.id=? AND i.owner_token=?)"
      )
      .run(now(), interactionId, token).changes;
  }
  reconcileAbsentOwners(): number {
    const candidates = this.sqlite
      .prepare(
        `SELECT id, owner_token AS token, owner_pid AS pid, owner_host AS host
         FROM interaction WHERE status='running'
         UNION
         SELECT i.id, i.owner_token AS token, i.owner_pid AS pid, i.owner_host AS host
         FROM delivery_attempt d JOIN message m ON m.id=d.message_id
         JOIN interaction i ON i.id=m.interaction_id WHERE d.status='pending'`
      )
      .all() as { id: string; token: string; pid: number; host: string }[];
    let recovered = 0;
    for (const candidate of candidates) {
      if (
        candidate.host !== os.hostname() ||
        candidate.token === this.owner.token ||
        !Number.isSafeInteger(candidate.pid) ||
        candidate.pid < 1
      )
        continue;
      try {
        process.kill(candidate.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      recovered += this.write(() => {
        const execution = this.terminalInteraction(
          candidate.id,
          "interrupted",
          "owner_absent",
          true,
          candidate.token
        );
        const delivery = this.uncertainDeliveries(candidate.id, candidate.token);
        return execution || delivery > 0 ? 1 : 0;
      });
    }
    return recovered;
  }
}

export function openHistoryStore(options: HistoryStoreOptions = {}): HistoryStore {
  const owner = Object.freeze({
    ...contracts.parseHistory(contracts.HistoryOwnerSchema, options.owner ?? processOwner)
  });
  if (metadata(owner.token) !== owner.token || metadata(owner.host) !== owner.host)
    throw new Error("Unsafe history owner");
  const sqlite = openConnection(options, false)!;
  try {
    const store = new HistoryStore(sqlite, owner, fs.realpathSync(options.home ?? agentOpsHome()));
    store.reconcileAbsentOwners();
    return store;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function openHistoryReadConnection(
  options: HistoryOpenOptions = {}
): Database.Database | undefined {
  return openConnection(options, true);
}

export function openHistoryReader(options: HistoryOpenOptions = {}): HistoryReader | undefined {
  const sqlite = openHistoryReadConnection(options);
  return sqlite ? new HistoryReader(sqlite) : undefined;
}

const bootstrapSql = `
CREATE TABLE interaction (
 id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL, application_id TEXT, source_message_id TEXT, conversation_key TEXT, target TEXT,
 owner_token TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_host TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
 CONSTRAINT ck_interaction_source CHECK ((source='cli' AND application_id IS NULL AND source_message_id IS NULL) OR (source='discord' AND application_id IS NOT NULL AND source_message_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_interaction_source ON interaction(source, application_id, source_message_id);
CREATE INDEX ix_interaction_time ON interaction(started_at,id);
CREATE INDEX ix_interaction_target ON interaction(target,started_at,id);
CREATE INDEX ix_interaction_source_time ON interaction(source,started_at,id);
CREATE INDEX ix_interaction_status ON interaction(status,started_at,id);
CREATE INDEX ix_interaction_owner ON interaction(owner_host,owner_pid);
CREATE TABLE run (
 id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL REFERENCES interaction(id), parent_run_id INTEGER,
 triggering_tool_call_id INTEGER REFERENCES tool_call(id), kind TEXT NOT NULL, target TEXT, ref TEXT, commit_sha TEXT, metadata TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
 FOREIGN KEY(parent_run_id,interaction_id) REFERENCES run(id,interaction_id)
);
CREATE UNIQUE INDEX ux_run_interaction ON run(id,interaction_id);
CREATE UNIQUE INDEX ux_run_root ON run(interaction_id) WHERE parent_run_id IS NULL;
CREATE INDEX ix_run_activity ON run(interaction_id,started_at,id);
CREATE TABLE message (
 id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL REFERENCES interaction(id), run_id INTEGER, sequence INTEGER NOT NULL,
 role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(run_id,interaction_id) REFERENCES run(id,interaction_id)
);
CREATE UNIQUE INDEX ux_message_sequence ON message(interaction_id,sequence);
CREATE TABLE tool_call (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES run(id), parent_call_id INTEGER REFERENCES tool_call(id), ordinal INTEGER NOT NULL,
 provider_call_id TEXT, source TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, result TEXT,
 status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT, error TEXT
);
CREATE UNIQUE INDEX ux_tool_ordinal ON tool_call(run_id,ordinal);
CREATE INDEX ix_tool_activity ON tool_call(run_id,started_at,id);
CREATE TABLE model_call (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES run(id), ordinal INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 usage_state TEXT NOT NULL DEFAULT 'unknown', input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
 status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
 CONSTRAINT ck_model_usage CHECK ((usage_state='unknown' AND input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL) OR (usage_state='known' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND total_tokens IS NOT NULL AND input_tokens>=0 AND output_tokens>=0 AND total_tokens>=0))
);
CREATE UNIQUE INDEX ux_model_ordinal ON model_call(run_id,ordinal);
CREATE INDEX ix_model_activity ON model_call(run_id,started_at,id);
CREATE TABLE artifact (
 id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL REFERENCES interaction(id), run_id INTEGER, path TEXT NOT NULL, type TEXT NOT NULL, title TEXT,
 availability TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(run_id,interaction_id) REFERENCES run(id,interaction_id)
);
CREATE INDEX ix_artifact_interaction ON artifact(interaction_id,id);
CREATE INDEX ix_artifact_run ON artifact(run_id,id);
CREATE TABLE delivery_attempt (
 id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES message(id), part INTEGER NOT NULL, attempt INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', surface_message_id TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX ux_delivery_attempt ON delivery_attempt(message_id,part,attempt);
CREATE INDEX ix_delivery_pending ON delivery_attempt(message_id) WHERE status='pending';
`;
