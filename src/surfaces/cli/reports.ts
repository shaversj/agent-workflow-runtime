import { Type } from "typebox";

import {
  displayInspectionTarget,
  getLatestInspectionReport,
  type InspectionReportSummary
} from "../../db/inspection.js";
import { normalizeCliArgs, parseCli } from "./args.js";

const ReportsArgsSchema = Type.Object(
  {
    command: Type.Literal("latest"),
    repoTarget: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);

export function runReportsCli(args: string[]) {
  const { repoTarget } = parseReportsCliArgs(args);
  const report = getLatestInspectionReport({ repoTarget });
  console.log(formatLatestReport(report, repoTarget));
}

export function parseReportsCliArgs(args: string[]) {
  const [command, ...rest] = normalizeCliArgs(args);
  if (command !== "latest") {
    throw new Error("reports requires a subcommand: latest");
  }
  if (rest.some((arg) => arg.startsWith("--")))
    throw new Error("reports latest accepts no options");
  if (rest.length > 1) throw new Error("reports latest accepts one optional repository target");
  const repoTarget = rest[0];
  return parseCli(ReportsArgsSchema, { command, repoTarget });
}

function formatLatestReport(
  report: InspectionReportSummary | undefined,
  repoTarget: string | undefined
): string {
  if (!report) {
    return repoTarget
      ? `No readiness reports were found for ${displayInspectionTarget(repoTarget)}.`
      : "No readiness reports were found.";
  }
  const lines = [
    `Latest readiness report for ${report.target}.`,
    `Report: ${report.report_path}`,
    `Run: ${report.run_ref ?? "unknown"}`,
    `Status: ${report.status ?? "unknown"}`,
    `Rules benchmark: ${report.benchmark_status ?? "unknown"}`,
    `Ref: ${report.ref ?? "unknown"}`,
    `Commit: ${report.short_commit ?? "unknown"}`,
    `Updated: ${report.updated_at ?? "unknown"}`,
    `Bytes: ${report.bytes}`
  ];
  if (report.token_count !== undefined) lines.push(`Tokens: ${report.token_count}`);
  if (report.tool_call_count !== undefined) lines.push(`Tool calls: ${report.tool_call_count}`);
  if (report.failure_reason) lines.push(`Failure reason: ${report.failure_reason}`);
  return lines.join("\n");
}
