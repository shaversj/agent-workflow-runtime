import path from "node:path";

import {
  listInspectionRuns,
  showInspectionRun,
  type InspectionRunDetail,
  type InspectionRunSummary
} from "../../db/inspection.js";

export function runRunsCli(args: string[]) {
  const [subcommand, ...rest] = args.filter((arg) => arg !== "--");
  if (subcommand === "list") {
    const { repoTarget, limit } = parseListArgs(rest);
    const result = listInspectionRuns({ repoTarget, limit });
    console.log(formatRunList(result.runs));
    return;
  }
  if (subcommand === "show") {
    const { runRef, repoTarget } = parseShowArgs(rest);
    const result = showInspectionRun(runRef, { repoTarget });
    if (!result.found) {
      console.log(result.reason);
      if (result.matches?.length) console.log(formatRunList(result.matches));
      process.exitCode = 1;
      return;
    }
    console.log(formatRunDetail(result.run));
    return;
  }
  throw new Error("runs requires a subcommand: list or show");
}

function parseListArgs(args: string[]): { repoTarget?: string; limit?: number } {
  const positional: string[] = [];
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) throw new Error("--limit requires a value");
      limit = parsePositiveInteger(value, "--limit");
      index += 1;
    } else if (arg) {
      positional.push(arg);
    }
  }
  return { repoTarget: positional[0], limit };
}

function parseShowArgs(args: string[]): { runRef: string; repoTarget?: string } {
  const [runRef, repoTarget] = args;
  if (!runRef) throw new Error("runs show requires a run reference");
  return { runRef, repoTarget };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${flag} must be an integer between 1 and 100`);
  }
  return parsed;
}

function formatRunList(runs: InspectionRunSummary[]): string {
  if (runs.length === 0) return "No readiness sweep runs were found.";
  const lines = ["Recent readiness sweep runs:"];
  for (const run of runs) {
    lines.push(
      [
        run.run_ref,
        `status=${run.status}`,
        `target=${shortTarget(run.target)}`,
        `ref=${run.ref ?? "unknown"}`,
        `commit=${run.short_commit ?? "unknown"}`,
        `tokens=${run.token_count ?? "unknown"}`,
        `tools=${run.tool_call_count}`,
        `report=${run.report_path ? path.basename(run.report_path) : "none"}`
      ].join(" ")
    );
    if (run.failure_reason) lines.push(`  failure=${run.failure_reason}`);
  }
  return lines.join("\n");
}

function formatRunDetail(run: InspectionRunDetail): string {
  const lines = [
    `Run: ${run.run_ref}`,
    `Status: ${run.status}`,
    `Target: ${run.target}`,
    `Ref: ${run.ref ?? "unknown"}`,
    `Commit: ${run.commit_sha ?? "unknown"}`,
    `Report: ${run.report_path ?? "none"}`,
    `Tokens: ${run.token_count ?? "unknown"}`,
    `Tool calls: ${run.tool_call_count}`,
    `Started: ${run.started_at}`,
    `Finished: ${run.finished_at ?? "unknown"}`,
    `Model: ${run.model ?? "unknown"}`,
    `Harness provider: ${run.harness_provider ?? "unknown"}`
  ];
  if (run.failure_reason) lines.push(`Failure reason: ${run.failure_reason}`);
  lines.push(
    `Interaction: ${run.interaction_id}`,
    `Usage completeness: ${run.usage_completeness}`,
    `Workflow activities: ${run.workflow_activity_count}`
  );
  if (run.tool_calls.length) {
    lines.push("", "Tool call details:");
    for (const call of run.tool_calls) {
      lines.push(`- ${call.name} ${call.is_error ? "error" : "ok"}`);
    }
    if (run.tool_calls_truncated)
      lines.push("Additional activity is available through history show.");
  }
  return lines.join("\n");
}

function shortTarget(target: string): string {
  return target.startsWith("http") ? target : path.basename(target);
}
