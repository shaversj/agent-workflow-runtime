import fs from "node:fs";
import path from "node:path";

import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { captureHistoryMetadata } from "../harness/history-capture.js";

import { ArtifactRecordSchema, parseHistory, RunRecordSchema } from "../harness/history-schemas.js";
import {
  InspectionReportSummarySchema,
  InspectionReadReportResultSchema,
  InspectionRunDetailSchema,
  InspectionRunListResultSchema,
  InspectionRunShowResultSchema,
  InspectionRunSummarySchema
} from "../harness/schemas.js";
import { isGitUrl, safeGitUrlForDisplay } from "../workspaces/index.js";
import { agentOpsHome, historyArtifactsPath } from "../workspaces/storage.js";
import { openHistoryReadConnection } from "./index.js";
import { parseInspectionRunRef } from "./run-ref.js";
import { artifacts, modelCalls, runs, toolCalls } from "./schema.js";

export type InspectionRunSummary = Static<typeof InspectionRunSummarySchema>;
export type InspectionRunDetail = Static<typeof InspectionRunDetailSchema>;
export type InspectionRunListResult = Static<typeof InspectionRunListResultSchema>;
export type InspectionRunShowResult = Static<typeof InspectionRunShowResultSchema>;
export type InspectionReportSummary = Static<typeof InspectionReportSummarySchema>;
const OptionsSchema = Type.Object(
  {
    repoTarget: Type.Optional(Type.String({ maxLength: 2048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);
type InspectOptions = Static<typeof OptionsSchema>;
type ReadDb = ReturnType<typeof drizzle>;
const ModelMetadata = Type.Object({
  model: Type.Optional(Type.String()),
  harnessProvider: Type.Optional(Type.String())
});

function targetPredicate(target?: string) {
  if (!target) return undefined;
  const normalized = captureHistoryMetadata(displayInspectionTarget(target))
    .text.replace(/\/$/, "")
    .replace(/\.git$/, "");
  return sql`(${runs.target} = ${normalized} OR ${runs.target} = ${normalized + ".git"} OR ${runs.target} = ${normalized + "/"})`;
}

function summary(db: ReadDb, raw: unknown): InspectionRunSummary {
  const run = parseHistory(RunRecordSchema, raw);
  const usage = db
    .select({
      known: sql<number>`count(case when ${modelCalls.usageState} = 'known' then 1 end)`,
      unknown: sql<number>`count(case when ${modelCalls.usageState} = 'unknown' then 1 end)`,
      tokens: sql<number | null>`sum(${modelCalls.totalTokens})`
    })
    .from(modelCalls)
    .where(eq(modelCalls.runId, run.id))
    .get()!;
  const counts = db
    .select({
      capability: sql<number>`count(case when ${toolCalls.kind} = 'capability' then 1 end)`,
      workflow: sql<number>`count(case when ${toolCalls.kind} = 'workflow' then 1 end)`
    })
    .from(toolCalls)
    .where(eq(toolCalls.runId, run.id))
    .get()!;
  const artifact = db
    .select({ path: artifacts.path })
    .from(artifacts)
    .where(and(eq(artifacts.runId, run.id), eq(artifacts.type, "markdown")))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(1)
    .get();
  let metadata: Static<typeof ModelMetadata> = {};
  try {
    const parsed: unknown = JSON.parse(run.metadata.text);
    if (Value.Check(ModelMetadata, parsed)) metadata = parsed;
  } catch {
    /* Captured metadata may be omitted or truncated. */
  }
  return parseHistory(InspectionRunSummarySchema, {
    interaction_id: run.interactionId,
    run_id: run.id,
    run_ref: String(run.id),
    status: run.status,
    target: run.target ?? "none",
    ref: run.ref ?? undefined,
    commit_sha: run.commitSha ?? undefined,
    short_commit: run.commitSha?.slice(0, 12),
    report_path: artifact?.path,
    token_count: usage.known ? (usage.tokens ?? 0) : undefined,
    usage_completeness: usage.unknown || !usage.known ? "unknown" : "complete",
    tool_call_count: counts.capability,
    workflow_activity_count: counts.workflow,
    failure_reason: run.error?.text,
    model: metadata.model,
    harness_provider: metadata.harnessProvider,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? undefined
  });
}

export function listInspectionRuns(options: InspectOptions = {}): InspectionRunListResult {
  parseHistory(OptionsSchema, options);
  const connection = openHistoryReadConnection();
  if (!connection) return { runs: [], count: 0 };
  try {
    const db = drizzle(connection);
    const rows = db
      .select()
      .from(runs)
      .where(and(eq(runs.kind, "readiness_sweep"), targetPredicate(options.repoTarget)))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(options.limit ?? 20)
      .all();
    const result = rows.map((row) => summary(db, row));
    return parseHistory(InspectionRunListResultSchema, { runs: result, count: result.length });
  } finally {
    connection.close();
  }
}

export function showInspectionRun(
  runRef: string,
  options: Pick<InspectOptions, "repoTarget"> = {}
): InspectionRunShowResult {
  parseHistory(OptionsSchema, options);
  const parsed = parseInspectionRunRef(runRef);
  if (!parsed)
    return {
      found: false,
      reason:
        "Invalid run reference. Use a global positive integer run ID; target-qualified references are no longer supported."
    };
  const connection = openHistoryReadConnection();
  if (!connection) return { found: false, reason: `Run ${parsed.runId} was not found.` };
  try {
    const db = drizzle(connection);
    const row = db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, parsed.runId),
          eq(runs.kind, "readiness_sweep"),
          targetPredicate(options.repoTarget)
        )
      )
      .get();
    if (!row) return { found: false, reason: `Run ${parsed.runId} was not found.` };
    // Narrow projections deliberately exclude captured messages and tool inputs/results.
    const calls = db
      .select({
        name: toolCalls.name,
        is_error:
          sql<boolean>`(${toolCalls.status} IN ('failed','cancelled','interrupted'))`.mapWith(
            Boolean
          ),
        created_at: toolCalls.startedAt
      })
      .from(toolCalls)
      .where(eq(toolCalls.runId, row.id))
      .orderBy(toolCalls.id)
      .limit(101)
      .all();
    return parseHistory(InspectionRunShowResultSchema, {
      found: true,
      run: {
        ...summary(db, row),
        tool_calls: calls.slice(0, 100),
        tool_calls_truncated: calls.length > 100
      }
    });
  } finally {
    connection.close();
  }
}

function selectedReport(repoTarget?: string, reportPath?: string) {
  const connection = openHistoryReadConnection();
  if (!connection) return undefined;
  try {
    const db = drizzle(connection);
    const requested = reportPath
      ? path.resolve(historyArtifactsPath(fs.realpathSync(agentOpsHome())), reportPath)
      : undefined;
    const row = db
      .select({ artifact: artifacts, run: runs })
      .from(artifacts)
      .innerJoin(runs, eq(artifacts.runId, runs.id))
      .where(
        and(
          eq(artifacts.type, "markdown"),
          eq(runs.kind, "readiness_sweep"),
          targetPredicate(repoTarget),
          requested ? eq(artifacts.path, requested) : undefined
        )
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(1)
      .get();
    if (!row) return undefined;
    return {
      artifact: parseHistory(ArtifactRecordSchema, row.artifact),
      run: summary(db, row.run)
    };
  } finally {
    connection.close();
  }
}

export function openRegisteredReport(file: string, configuredHome = agentOpsHome()): number {
  const home = fs.realpathSync(configuredHome);
  const root = historyArtifactsPath(home);
  const candidate = path.resolve(file);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Report path is outside the registered artifact directory");
  for (const part of [path.dirname(root), root, candidate]) {
    // Reports are flat files. Reject nested paths rather than walking arbitrary directories.
    if (path.dirname(candidate) !== root)
      throw new Error("Report path must be a flat registered artifact");
    try {
      if (fs.lstatSync(part).isSymbolicLink()) throw new Error("Report path contains a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Registered report is missing");
      throw error;
    }
  }
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw new Error("Report is not a regular file");
  }
  return fd;
}

export function resolveInspectionReportPath(input: {
  reportPath: string;
  repoTarget?: string;
  expectedRunId?: number;
  expectedInteractionId?: string;
}): string {
  parseHistory(
    Type.Object(
      {
        reportPath: Type.String({ minLength: 1, maxLength: 2048 }),
        repoTarget: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        expectedRunId: Type.Optional(Type.Integer({ minimum: 1 })),
        expectedInteractionId: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }))
      },
      { additionalProperties: false }
    ),
    input
  );
  const selected = selectedReport(input.repoTarget, input.reportPath);
  if (
    !selected ||
    !selected.artifact.path.endsWith(".md") ||
    selected.artifact.interactionId !== selected.run.interaction_id ||
    (input.expectedRunId !== undefined && selected.run.run_id !== input.expectedRunId) ||
    (input.expectedInteractionId !== undefined &&
      selected.run.interaction_id !== input.expectedInteractionId)
  )
    throw new Error("No registered readiness report was found for this workflow/target/path.");
  const fd = openRegisteredReport(selected.artifact.path);
  try {
    return selected.artifact.path;
  } finally {
    fs.closeSync(fd);
  }
}

export function getLatestInspectionReport(
  options: Pick<InspectOptions, "repoTarget"> = {}
): InspectionReportSummary | undefined {
  parseHistory(OptionsSchema, options);
  const selected = selectedReport(options.repoTarget);
  if (!selected) return undefined;
  const fd = openRegisteredReport(selected.artifact.path);
  try {
    const stat = fs.fstatSync(fd);
    const run = selected.run;
    return parseHistory(InspectionReportSummarySchema, {
      interaction_id: run.interaction_id,
      run_ref: run.run_ref,
      run_id: run.run_id,
      status: run.status,
      target: run.target,
      ref: run.ref,
      commit_sha: run.commit_sha,
      short_commit: run.short_commit,
      report_path: selected.artifact.path,
      bytes: stat.size,
      updated_at: selected.artifact.createdAt,
      token_count: run.token_count,
      tool_call_count: run.tool_call_count,
      failure_reason: run.failure_reason
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function readInspectionReport(input: {
  repoTarget?: string;
  reportPath?: string;
  maxBytes?: number;
}) {
  parseHistory(
    Type.Object(
      {
        repoTarget: Type.Optional(Type.String()),
        reportPath: Type.Optional(Type.String()),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000 }))
      },
      { additionalProperties: false }
    ),
    input
  );
  const selected = selectedReport(input.repoTarget, input.reportPath);
  if (!selected) throw new Error("No registered readiness report was found for this target/path.");
  const fd = openRegisteredReport(selected.artifact.path);
  try {
    const size = fs.fstatSync(fd).size;
    const max = input.maxBytes ?? 12000;
    const buffer = Buffer.alloc(Math.min(size, max));
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return parseHistory(InspectionReadReportResultSchema, {
      repo_path: selected.run.target,
      report_path: selected.artifact.path,
      content: buffer.subarray(0, count).toString("utf8"),
      truncated: size > count
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function displayInspectionTarget(value: string): string {
  if (isGitUrl(value)) return safeGitUrlForDisplay(value);
  return path.resolve(value).replace(/^\/var\//, "/private/var/");
}
