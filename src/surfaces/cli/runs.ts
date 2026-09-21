import path from "node:path";

import { Type } from "typebox";

import {
  listInspectionRuns,
  showInspectionRun,
  type InspectionRunDetail,
  type InspectionRunSummary
} from "../../db/inspection.js";
import { markOption, normalizeCliArgs, parseCli, takeOptionValue } from "./args.js";

const RunsArgsSchema = Type.Union([
  Type.Object(
    {
      command: Type.Literal("list"),
      repoTarget: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      command: Type.Literal("show"),
      runRef: Type.String({ minLength: 1 }),
      repoTarget: Type.Optional(Type.String({ minLength: 1 }))
    },
    { additionalProperties: false }
  )
]);

export function runRunsCli(args: string[]) {
  const parsed = parseRunsCliArgs(args);
  if (parsed.command === "list") {
    const { repoTarget, limit } = parsed;
    const result = listInspectionRuns({ repoTarget, limit });
    console.log(formatRunList(result.runs));
    return;
  }
  if (parsed.command === "show") {
    const { runRef, repoTarget } = parsed;
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
}

export function parseRunsCliArgs(args: string[]) {
  const [command, ...rest] = normalizeCliArgs(args);
  if (command === "list") return parseListArgs(rest);
  if (command === "show") return parseShowArgs(rest);
  throw new Error("runs requires a subcommand: list or show");
}

function parseListArgs(args: string[]) {
  const positional: string[] = [];
  const seen = new Set<string>();
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      markOption(seen, arg);
      const value = takeOptionValue(args, index, arg);
      limit = parsePositiveInteger(value, "--limit");
      index += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown runs argument: ${arg}`);
    } else if (arg) {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error("runs list accepts at most one repository target");
  return parseCli(RunsArgsSchema, { command: "list", repoTarget: positional[0], limit });
}

function parseShowArgs(args: string[]) {
  if (args.some((arg) => arg.startsWith("--"))) throw new Error("runs show accepts no options");
  const [runRef, repoTarget] = args;
  if (!runRef) throw new Error("runs show requires a run reference");
  if (args.length > 2) throw new Error("runs show accepts one optional repository target");
  return parseCli(RunsArgsSchema, { command: "show", runRef, repoTarget });
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
