import crypto from "node:crypto";
import os from "node:os";

import type Database from "better-sqlite3";
import { and, desc, eq, gte, lte, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Static, TSchema } from "typebox";

import * as c from "../harness/history-schemas.js";
import { openHistoryReadConnection } from "./index.js";
import type { HistoryOpenOptions } from "./index.js";
import {
  artifacts,
  deliveryAttempts,
  interactions,
  messages,
  modelCalls,
  runs,
  toolCalls
} from "./schema.js";

function timestamp(value: string): string {
  c.parseHistory(c.HistoryTimestampSchema, value);
  const date = new Date(value);
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(calendar.getTime()) ||
    !calendar.toISOString().startsWith(day) ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    throw new Error("Invalid history ISO timestamp");
  return date.toISOString();
}

const contextHash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Cursor = Static<typeof c.HistoryCursorSchema>;
function decodeCursor(
  value: string | undefined,
  context: string,
  kind: "list" | "activity"
): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const cursor = c.parseHistory(
      c.HistoryCursorSchema,
      JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    );
    if (cursor.context !== context || timestamp(cursor.at) !== cursor.at)
      throw new Error("context");
    if (kind === "list") c.parseHistory(c.HistoryInteractionIdSchema, cursor.key);
    else c.parseHistory(c.HistoryActivityRefSchema.properties.key, cursor.key);
    return cursor;
  } catch {
    throw new Error("Invalid history cursor or filter context");
  }
}
function encodeCursor(context: string, at: string, key: string): string {
  return Buffer.from(
    JSON.stringify(c.parseHistory(c.HistoryCursorSchema, { version: 1, context, at, key }))
  ).toString("base64url");
}

function readHistory<T>(
  options: HistoryOpenOptions,
  read: (sqlite: Database.Database | undefined) => T
): T {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = openHistoryReadConnection(options);
    // A deferred read transaction keeps annotations and activity on the same SQLite snapshot.
    return sqlite ? sqlite.transaction(() => read(sqlite))() : read(undefined);
  } catch (cause) {
    throw new Error("History read failed: unreadable, corrupt, or unsupported store", { cause });
  } finally {
    sqlite?.close();
  }
}

function ownership(row: {
  status: string;
  ownerPid: number;
  ownerHost: string;
}): c.HistoryListResult["interactions"][number]["ownership"] {
  if (row.status !== "running") return "not-applicable";
  if (row.ownerHost !== os.hostname()) return "foreign";
  try {
    process.kill(row.ownerPid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "uncertain";
  }
}

function annotations(sqlite: Database.Database, row: Static<typeof c.HistorySummaryRowSchema>) {
  // Only model_call rows represent usage observations; run-level rollups are never summed.
  const usage = c.parseHistory(
    c.HistoryUsageSchema,
    sqlite
      .prepare(
        `
    SELECT count(CASE WHEN m.usage_state='known' THEN 1 END) AS knownCalls,
      count(CASE WHEN m.usage_state='unknown' THEN 1 END) AS unknownCalls,
      coalesce(sum(CASE WHEN m.usage_state='known' THEN m.input_tokens END),0) AS inputTokens,
      coalesce(sum(CASE WHEN m.usage_state='known' THEN m.output_tokens END),0) AS outputTokens,
      coalesce(sum(CASE WHEN m.usage_state='known' THEN m.total_tokens END),0) AS totalTokens
    FROM model_call m JOIN run r ON r.id=m.run_id WHERE r.interaction_id=?
  `
      )
      .get(row.id)
  );
  const delivery = c.parseHistory(
    c.HistoryDeliverySchema,
    sqlite
      .prepare(
        `
    SELECT count(CASE WHEN d.status='pending' THEN 1 END) AS pending,
      count(CASE WHEN d.status='acknowledged' THEN 1 END) AS acknowledged,
      count(CASE WHEN d.status='failed' THEN 1 END) AS failed,
      count(CASE WHEN d.status='uncertain' THEN 1 END) AS uncertain
    FROM delivery_attempt d JOIN message m ON m.id=d.message_id WHERE m.interaction_id=?
  `
      )
      .get(row.id)
  );
  return { ownership: ownership(row), usage, delivery };
}

const summaryColumns = {
  id: interactions.id,
  source: interactions.source,
  target: interactions.target,
  status: interactions.status,
  startedAt: interactions.startedAt,
  finishedAt: interactions.finishedAt,
  incomplete: interactions.incomplete,
  ownerPid: interactions.ownerPid,
  ownerHost: interactions.ownerHost
};

export function listHistory(options: unknown = {}): c.HistoryListResult {
  const p = c.parseHistory(c.HistoryListOptionsSchema, options);
  const since = p.since === undefined ? undefined : timestamp(p.since);
  const until = p.until === undefined ? undefined : timestamp(p.until);
  if (since && until && since > until) throw new Error("Invalid history time range");
  const context = contextHash([
    "list",
    p.target ?? null,
    p.source ?? null,
    p.outcome ?? null,
    since ?? null,
    until ?? null
  ]);
  const cursor = decodeCursor(p.cursor, context, "list");
  const limit = p.limit ?? 20;
  return readHistory(p, (sqlite) => {
    if (!sqlite)
      return c.parseHistory(c.HistoryListResultSchema, {
        store: "absent",
        interactions: [],
        nextCursor: null
      });
    const rows = drizzle(sqlite)
      .select(summaryColumns)
      .from(interactions)
      .where(
        and(
          p.target === undefined ? undefined : eq(interactions.target, p.target),
          p.source === undefined ? undefined : eq(interactions.source, p.source),
          p.outcome === undefined ? undefined : eq(interactions.status, p.outcome),
          since === undefined ? undefined : gte(interactions.startedAt, since),
          until === undefined ? undefined : lte(interactions.startedAt, until),
          cursor === undefined
            ? undefined
            : or(
                lt(interactions.startedAt, cursor.at),
                and(eq(interactions.startedAt, cursor.at), lt(interactions.id, cursor.key))
              )
        )
      )
      .orderBy(desc(interactions.startedAt), desc(interactions.id))
      .limit(limit + 1)
      .all()
      .map((row) => validateRecord(c.HistorySummaryRowSchema, row));
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return c.parseHistory(c.HistoryListResultSchema, {
      store: "available",
      interactions: page.map((row) => {
        return {
          id: row.id,
          source: row.source,
          target: row.target,
          status: row.status,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          incomplete: row.incomplete,
          ...annotations(sqlite, row)
        };
      }),
      nextCursor:
        rows.length > limit && last ? encodeCursor(context, last.startedAt, last.id) : null
    });
  });
}

function validateRecord<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const row = c.parseHistory(schema, value);
  // The root row contracts validate shape; capture envelopes also enforce byte-size invariants.
  for (const [key, capture] of Object.entries(row)) {
    if (["content", "metadata", "input", "result", "error"].includes(key) && capture !== null)
      c.parseHistory(c.CaptureEnvelopeSchema, capture);
    if (
      ["startedAt", "finishedAt", "createdAt", "at"].includes(key) &&
      capture !== null &&
      timestamp(capture as string) !== capture
    )
      throw new Error("Invalid canonical history timestamp");
  }
  return row;
}

function activityRecord(
  sqlite: Database.Database,
  ref: Static<typeof c.HistoryActivityRefSchema>
): c.HistoryActivityItem {
  const db = drizzle(sqlite);
  const projections = {
    message: { table: messages, schema: c.MessageRecordSchema },
    run: { table: runs, schema: c.RunRecordSchema },
    tool: { table: toolCalls, schema: c.ToolCallRecordSchema },
    model: { table: modelCalls, schema: c.ModelCallRecordSchema },
    artifact: { table: artifacts, schema: c.ArtifactRecordSchema },
    delivery: { table: deliveryAttempts, schema: c.DeliveryAttemptRecordSchema }
  };
  const { table, schema } = projections[ref.kind];
  const record = validateRecord(schema, db.select().from(table).where(eq(table.id, ref.id)).get());
  return c.parseHistory(c.HistoryActivityItemSchema, {
    kind: ref.kind,
    at: ref.at,
    key: ref.key,
    record
  });
}

export function showHistory(id: unknown, options: unknown = {}): c.HistoryDetailResult {
  const interactionId = c.parseHistory(c.HistoryInteractionIdSchema, id).toLowerCase();
  const p = c.parseHistory(c.HistoryShowOptionsSchema, options);
  const context = contextHash(["activity", interactionId]);
  const cursor = decodeCursor(p.cursor, context, "activity");
  const limit = p.limit ?? 50;
  return readHistory(p, (sqlite) => {
    if (!sqlite)
      return c.parseHistory(c.HistoryDetailResultSchema, {
        store: "absent",
        found: false,
        reason: "History store does not exist."
      });
    const db = drizzle(sqlite);
    const row = db.select().from(interactions).where(eq(interactions.id, interactionId)).get();
    if (!row)
      return c.parseHistory(c.HistoryDetailResultSchema, {
        store: "available",
        found: false,
        reason: "Interaction was not found."
      });
    const interaction = validateRecord(c.InteractionRecordSchema, row);
    const summary = c.parseHistory(c.HistorySummaryRowSchema, {
      id: row.id,
      source: row.source,
      target: row.target,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      incomplete: row.incomplete,
      ownerPid: row.ownerPid,
      ownerHost: row.ownerHost
    });
    // Fetch only activity identities here; captured payloads are read for the bounded page below.
    const refs = sqlite
      .prepare(
        `
      SELECT kind,id,at,kind || ':' || id AS key FROM (
        SELECT 'message' AS kind,id,created_at AS at FROM message WHERE interaction_id=@interactionId
        UNION ALL SELECT 'run',id,started_at FROM run WHERE interaction_id=@interactionId
        UNION ALL SELECT 'tool',t.id,t.started_at FROM tool_call t JOIN run r ON r.id=t.run_id WHERE r.interaction_id=@interactionId
        UNION ALL SELECT 'model',m.id,m.started_at FROM model_call m JOIN run r ON r.id=m.run_id WHERE r.interaction_id=@interactionId
        UNION ALL SELECT 'artifact',id,created_at FROM artifact WHERE interaction_id=@interactionId
        UNION ALL SELECT 'delivery',d.id,d.started_at FROM delivery_attempt d JOIN message m ON m.id=d.message_id WHERE m.interaction_id=@interactionId
      ) WHERE (@at IS NULL OR at>@at OR (at=@at AND kind || ':' || id>@key))
      ORDER BY at ASC,key ASC LIMIT @limit
    `
      )
      .all({ interactionId, at: cursor?.at ?? null, key: cursor?.key ?? null, limit: limit + 1 })
      .map((ref) => validateRecord(c.HistoryActivityRefSchema, ref));
    const page = refs.slice(0, limit);
    const last = page.at(-1);
    return c.parseHistory(c.HistoryDetailResultSchema, {
      store: "available",
      found: true,
      interaction: { ...interaction, ...annotations(sqlite, summary) },
      activity: {
        items: page.map((ref) => activityRecord(sqlite, ref)),
        nextCursor: refs.length > limit && last ? encodeCursor(context, last.at, last.key) : null
      }
    });
  });
}
