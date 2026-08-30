import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import type { Static } from "typebox";

import {
  InspectionReportSummarySchema,
  InspectionReadReportResultSchema,
  InspectionRunDetailSchema,
  InspectionRunListResultSchema,
  InspectionRunShowResultSchema,
  InspectionRunSummarySchema
} from "../harness/schemas.js";
import {
  isGitUrl,
  parseTargetRef,
  safeGitUrlForDisplay,
  targetStorageKey
} from "../workspaces/index.js";
import { parseInspectionRunRef } from "./run-ref.js";
import { quoteIdentifier } from "./sql.js";
import { agentOpsHome } from "../workspaces/storage.js";

const DATABASE_NAME = "agent-ops.db";
const REPORTS_DIR_NAME = "reports";
const SHORT_SHA_LENGTH = 12;

export type InspectionRunSummary = Static<typeof InspectionRunSummarySchema>;
export type InspectionRunDetail = Static<typeof InspectionRunDetailSchema>;
export type InspectionRunListResult = Static<typeof InspectionRunListResultSchema>;
export type InspectionRunShowResult = Static<typeof InspectionRunShowResultSchema>;
export type InspectionReportSummary = Static<typeof InspectionReportSummarySchema>;
type InspectionReadReportResult = Static<typeof InspectionReadReportResultSchema>;

interface InspectOptions {
  repoTarget?: string;
  limit?: number;
}

interface StateRecord {
  targetKey: string;
  statePath: string;
  databasePath?: string;
}

interface RunRow {
  run_id: number;
  task_id: number;
  status: string;
  harness_provider: string | null;
  model: string | null;
  token_count: number | null;
  failure_reason: string | null;
  summary: string | null;
  context: unknown;
  started_at: string;
  finished_at: string | null;
  repository_name: string;
  repository_local_path: string;
  repository_remote_url: string | null;
  report_path: string | null;
  report_created_at: string | null;
  tool_call_count: number;
}

interface ToolCallRow {
  name: string;
  is_error: number;
  created_at: string | null;
}

export function listInspectionRuns(options: InspectOptions = {}): InspectionRunListResult {
  const runs = readAllRunSummaries(options.repoTarget)
    .sort(compareRunsNewestFirst)
    .slice(0, normalizedLimit(options.limit));
  return { runs, count: runs.length };
}

export function showInspectionRun(
  runRef: string,
  options: Pick<InspectOptions, "repoTarget"> = {}
): InspectionRunShowResult {
  const parsed = parseRunRef(runRef);
  if (!parsed) return { found: false, reason: `Invalid run reference: ${runRef}` };

  const states = parsed.targetKey
    ? stateRecordsForTargetKey(parsed.targetKey)
    : discoverStateRecords();
  const matches = states
    .flatMap((state) => readRunDetailsFromState(state, parsed.runId))
    .filter((run) => matchesRequestedTarget(run, options.repoTarget));

  if (matches.length === 1) return { found: true, run: matches[0]! };
  if (matches.length > 1) {
    return {
      found: false,
      reason: `Run ${runRef} is ambiguous. Use a target-qualified run reference.`,
      matches: matches.map(runDetailToSummary)
    };
  }
  return { found: false, reason: `Run ${runRef} was not found.` };
}

export function getLatestInspectionReport(
  options: Pick<InspectOptions, "repoTarget"> = {}
): InspectionReportSummary | undefined {
  const dbReports = readAllRunSummaries(options.repoTarget)
    .filter((run) => Boolean(run.report_path))
    .sort(compareRunsNewestFirst);
  for (const dbReport of dbReports) {
    if (!dbReport.report_path) continue;
    const reportPath = safeReportPathForState(
      stateRecordForKey(dbReport.target_key, false),
      dbReport.report_path
    );
    if (!reportPath) continue;
    const stat = fs.statSync(reportPath);
    return dbRunToReportSummary(dbReport, reportPath, stat);
  }

  const fallbackReports = fallbackReportStates(options.repoTarget)
    .flatMap((state) => {
      const report = latestFilesystemReport(state);
      return report ? [report] : [];
    })
    .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
  const fallbackReport = fallbackReports[0];
  return fallbackReport && options.repoTarget
    ? { ...fallbackReport, target: displayTarget(options.repoTarget) }
    : fallbackReport;
}

export function readInspectionReport(input: {
  repoTarget?: string;
  reportPath?: string;
  maxBytes?: number;
}): InspectionReadReportResult {
  const reportPath = input.reportPath
    ? resolveRequestedReportPath(input.reportPath, input.repoTarget)
    : getLatestInspectionReport({ repoTarget: input.repoTarget })?.report_path;
  const repoDisplay = input.repoTarget ? displayTarget(input.repoTarget) : "managed state";
  if (!reportPath) throw new Error(`No readiness reports were found for ${repoDisplay}.`);

  const raw = fs.readFileSync(reportPath);
  const maxBytes = input.maxBytes ?? 12000;
  const truncated = raw.byteLength > maxBytes;
  return {
    repo_path: repoDisplay,
    report_path: reportPath,
    content: raw.subarray(0, maxBytes).toString("utf8"),
    truncated
  };
}

function readAllRunSummaries(repoTarget: string | undefined): InspectionRunSummary[] {
  return discoverStateRecords()
    .flatMap((state) => readRunRows(state).map((row) => rowToRunSummary(state, row)))
    .filter((run) => matchesRequestedTarget(run, repoTarget));
}

function readRunDetailsFromState(state: StateRecord, runId: number): InspectionRunDetail[] {
  const rows = readRunRows(state, runId);
  return rows.map((row) => ({
    ...rowToRunSummary(state, row),
    summary: row.summary ?? undefined,
    tool_calls: readToolCalls(state, runId)
  }));
}

function readRunRows(state: StateRecord, runId?: number): RunRow[] {
  if (!state.databasePath) return [];
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(state.databasePath, { readonly: true, fileMustExist: true });
    const runColumns = tableColumns(sqlite, "run");
    const hasArtifact = tableExists(sqlite, "artifact");
    const hasToolCall = tableExists(sqlite, "tool_call");
    const whereClause = runId === undefined ? "" : "WHERE r.id = ?";
    const statement = sqlite.prepare(`
      SELECT
        r.id AS run_id,
        r.task_id AS task_id,
        r.status AS status,
        ${runColumns.has("provider") ? "r.provider" : "NULL"} AS harness_provider,
        r.model AS model,
        ${runColumns.has("token_count") ? "r.token_count" : "NULL"} AS token_count,
        ${runColumns.has("failure_reason") ? "r.failure_reason" : "NULL"} AS failure_reason,
        r.summary AS summary,
        r.context AS context,
        r.started_at AS started_at,
        r.finished_at AS finished_at,
        repo.name AS repository_name,
        repo.local_path AS repository_local_path,
        repo.remote_url AS repository_remote_url,
        ${
          hasArtifact
            ? "(SELECT a.path_or_url FROM artifact a WHERE a.run_id = r.id AND a.type = 'markdown_report' ORDER BY a.created_at DESC, a.id DESC LIMIT 1)"
            : "NULL"
        } AS report_path,
        ${
          hasArtifact
            ? "(SELECT a.created_at FROM artifact a WHERE a.run_id = r.id AND a.type = 'markdown_report' ORDER BY a.created_at DESC, a.id DESC LIMIT 1)"
            : "NULL"
        } AS report_created_at,
        ${
          hasToolCall ? "(SELECT count(*) FROM tool_call tc WHERE tc.run_id = r.id)" : "0"
        } AS tool_call_count
      FROM run r
      JOIN task t ON t.id = r.task_id
      JOIN repository repo ON repo.id = t.repository_id
      ${whereClause}
    `);
    return (runId === undefined ? statement.all() : statement.all(runId)) as RunRow[];
  } catch {
    return [];
  } finally {
    sqlite?.close();
  }
}

function readToolCalls(state: StateRecord, runId: number): InspectionRunDetail["tool_calls"] {
  if (!state.databasePath) return [];
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(state.databasePath, { readonly: true, fileMustExist: true });
    if (!tableExists(sqlite, "tool_call")) return [];
    const rows = sqlite
      .prepare("SELECT name, is_error, created_at FROM tool_call WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as ToolCallRow[];
    return rows.map((row) => ({
      name: row.name,
      is_error: Boolean(row.is_error),
      created_at: row.created_at ?? undefined
    }));
  } catch {
    return [];
  } finally {
    sqlite?.close();
  }
}

function rowToRunSummary(state: StateRecord, row: RunRow): InspectionRunSummary {
  const context = parseJsonRecord(row.context);
  const workspace = recordField(context, "workspace");
  const target =
    stringField(workspace, "displayOrigin") ??
    stringField(workspace, "origin") ??
    row.repository_remote_url ??
    row.repository_local_path ??
    row.repository_name;
  const commitSha = stringField(workspace, "commitSha");
  return {
    target_key: state.targetKey,
    run_ref: `${state.targetKey}:${row.run_id}`,
    run_id: row.run_id,
    task_id: row.task_id,
    status: toRunStatus(row.status),
    target: displayTarget(target),
    ref: stringField(workspace, "ref") ?? undefined,
    commit_sha: commitSha,
    short_commit: commitSha ? commitSha.slice(0, SHORT_SHA_LENGTH) : undefined,
    report_path: row.report_path ?? undefined,
    token_count: row.token_count ?? undefined,
    tool_call_count: row.tool_call_count,
    failure_reason: row.failure_reason ?? undefined,
    harness_provider: row.harness_provider ?? undefined,
    model: row.model ?? undefined,
    started_at: row.started_at,
    finished_at: row.finished_at ?? row.report_created_at ?? undefined
  };
}

function runDetailToSummary(run: InspectionRunDetail): InspectionRunSummary {
  return {
    target_key: run.target_key,
    run_ref: run.run_ref,
    run_id: run.run_id,
    task_id: run.task_id,
    status: run.status,
    target: run.target,
    ref: run.ref,
    commit_sha: run.commit_sha,
    short_commit: run.short_commit,
    report_path: run.report_path,
    token_count: run.token_count,
    tool_call_count: run.tool_call_count,
    failure_reason: run.failure_reason,
    harness_provider: run.harness_provider,
    model: run.model,
    started_at: run.started_at,
    finished_at: run.finished_at
  };
}

function discoverStateRecords(): StateRecord[] {
  return discoverTargetStateRecords({ requireDatabase: true });
}

function fallbackReportStates(repoTarget: string | undefined): StateRecord[] {
  if (!repoTarget) return discoverReportStateRecords();
  const targetKeys = candidateTargetKeys(repoTarget);
  const statesByKey = new Map<string, StateRecord>();
  for (const key of targetKeys) {
    const state = stateRecordForKey(key, false);
    if (fs.existsSync(path.join(state.statePath, REPORTS_DIR_NAME))) {
      statesByKey.set(key, state);
    }
  }
  for (const state of discoverReportStateRecords()) {
    statesByKey.set(state.targetKey, state);
  }
  return [...statesByKey.values()].filter((state) => targetKeys.includes(state.targetKey));
}

function discoverReportStateRecords(): StateRecord[] {
  return discoverTargetStateRecords({ requireReports: true });
}

function discoverTargetStateRecords(options: {
  requireDatabase?: boolean;
  requireReports?: boolean;
}): StateRecord[] {
  const targetsRoot = path.join(agentOpsHome(), "targets");
  if (!fs.existsSync(targetsRoot) || !fs.statSync(targetsRoot).isDirectory()) return [];
  return fs
    .readdirSync(targetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => stateRecordForKey(entry.name, options.requireDatabase ?? false))
    .filter((state) => !options.requireDatabase || Boolean(state.databasePath))
    .filter(
      (state) =>
        !options.requireReports || fs.existsSync(path.join(state.statePath, REPORTS_DIR_NAME))
    );
}

function stateRecordsForTargetKey(targetKey: string): StateRecord[] {
  if (!isSafeTargetKey(targetKey)) return [];
  const state = stateRecordForKey(targetKey);
  return state.databasePath ? [state] : [];
}

function stateRecordForKey(targetKey: string, requireDatabase = true): StateRecord {
  const statePath = path.join(agentOpsHome(), "targets", targetKey);
  const databasePath = path.join(statePath, DATABASE_NAME);
  return {
    targetKey,
    statePath,
    databasePath: fs.existsSync(databasePath) || !requireDatabase ? databasePath : undefined
  };
}

function latestFilesystemReport(state: StateRecord): InspectionReportSummary | undefined {
  const reportDir = path.join(state.statePath, REPORTS_DIR_NAME);
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return undefined;
  const realReportDir = fs.realpathSync(reportDir);
  const reports = fs
    .readdirSync(reportDir)
    .filter((entry) => entry.endsWith(".md"))
    .flatMap((entry) => {
      const reportPath = safeReportPath(realReportDir, path.join(reportDir, entry));
      if (!reportPath) return [];
      const stat = fs.statSync(reportPath);
      return {
        target_key: state.targetKey,
        target: state.targetKey,
        report_path: reportPath,
        bytes: stat.size,
        updated_at: new Date(stat.mtimeMs).toISOString()
      };
    })
    .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
  return reports[0];
}

function dbRunToReportSummary(
  run: InspectionRunSummary,
  reportPath: string,
  stat: fs.Stats
): InspectionReportSummary {
  return {
    target_key: run.target_key,
    run_ref: run.run_ref,
    run_id: run.run_id,
    status: run.status,
    target: run.target,
    ref: run.ref,
    commit_sha: run.commit_sha,
    short_commit: run.short_commit,
    report_path: reportPath,
    bytes: stat.size,
    updated_at: new Date(stat.mtimeMs).toISOString(),
    token_count: run.token_count,
    tool_call_count: run.tool_call_count,
    failure_reason: run.failure_reason
  };
}

function resolveRequestedReportPath(reportPath: string, repoTarget: string | undefined): string {
  const states = repoTarget ? fallbackReportStates(repoTarget) : discoverReportStateRecords();
  for (const state of states) {
    const candidatePath = path.isAbsolute(reportPath)
      ? path.resolve(reportPath)
      : path.resolve(state.statePath, REPORTS_DIR_NAME, reportPath);
    const safePath = safeReportPathForState(state, candidatePath);
    if (safePath) return safePath;
  }
  throw new Error(`Report path is outside the readiness reports directory: ${reportPath}`);
}

function safeReportPathForState(state: StateRecord, candidatePath: string): string | undefined {
  const reportDir = path.join(state.statePath, REPORTS_DIR_NAME);
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return undefined;
  return safeReportPath(fs.realpathSync(reportDir), candidatePath);
}

function safeReportPath(realReportDir: string, candidatePath: string): string | undefined {
  if (!fs.existsSync(candidatePath)) return undefined;
  const realCandidatePath = fs.realpathSync(candidatePath);
  const relativePath = path.relative(realReportDir, realCandidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  if (!fs.statSync(realCandidatePath).isFile()) return undefined;
  return realCandidatePath;
}

function matchesRequestedTarget(
  run: InspectionRunSummary,
  repoTarget: string | undefined
): boolean {
  if (!repoTarget) return true;
  const variants = targetIdentityVariants(repoTarget);
  const runIdentities = targetIdentityValues(run.target);
  return (
    variants.targetKeys.has(run.target_key) ||
    runIdentities.some((identity) => variants.identities.has(identity)) ||
    (run.report_path ? variants.identities.has(normalizeIdentity(run.report_path)) : false)
  );
}

function targetIdentityVariants(repoTarget: string): {
  targetKeys: Set<string>;
  identities: Set<string>;
} {
  const targetKeys = new Set<string>();
  const identities = new Set<string>();
  const trimmed = repoTarget.trim();
  if (isSafeTargetKey(trimmed)) targetKeys.add(trimmed);
  try {
    const target = parseTargetRef(trimmed);
    targetKeys.add(targetStorageKey(target));
    if (target.kind === "local-git") {
      for (const variant of localPathAliasVariants(target.path)) {
        targetKeys.add(targetStorageKey({ ...target, path: variant }));
      }
    }
  } catch {
    // Leave malformed targets to the caller's no-match path.
  }
  for (const value of targetIdentityValues(trimmed)) {
    identities.add(value);
  }
  return { targetKeys, identities };
}

function targetIdentityValues(value: string): string[] {
  const display = displayTarget(value);
  const values = new Set([normalizeIdentity(value), normalizeIdentity(display)]);
  if (!isGitUrl(value)) {
    const resolved = path.resolve(value);
    values.add(normalizeIdentity(resolved));
    for (const variant of localPathAliasVariants(resolved)) values.add(normalizeIdentity(variant));
  }
  return [...values];
}

function localPathAliasVariants(value: string): string[] {
  const resolved = path.resolve(value);
  if (resolved.startsWith("/var/")) return [`/private${resolved}`];
  if (resolved.startsWith("/private/var/")) return [resolved.replace(/^\/private/, "")];
  return [];
}

function candidateTargetKeys(repoTarget: string): string[] {
  return [...targetIdentityVariants(repoTarget).targetKeys];
}

function parseRunRef(runRef: string): { targetKey?: string; runId: number } | undefined {
  return parseInspectionRunRef(runRef);
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function tableColumns(sqlite: Database.Database, tableName: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRunStatus(status: string): InspectionRunSummary["status"] {
  if (status === "completed" || status === "failed" || status === "skipped") return status;
  return "running";
}

function displayTarget(value: string): string {
  return isGitUrl(value) ? safeGitUrlForDisplay(value) : path.resolve(value);
}

export function displayInspectionTarget(value: string): string {
  return displayTarget(value);
}

function normalizeIdentity(value: string): string {
  return displayTarget(value)
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
}

function isSafeTargetKey(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function normalizedLimit(limit: number | undefined): number {
  if (!limit) return 20;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
}

function compareRunsNewestFirst(left: InspectionRunSummary, right: InspectionRunSummary): number {
  const leftTime = left.finished_at ?? left.started_at;
  const rightTime = right.finished_at ?? right.started_at;
  const byTime = rightTime.localeCompare(leftTime);
  return byTime || right.run_id - left.run_id;
}
