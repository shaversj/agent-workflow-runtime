import {
  displayInspectionTarget,
  getLatestInspectionReport,
  type InspectionReportSummary
} from "../../db/inspection.js";

export function runReportsCli(args: string[]) {
  const [subcommand, ...rest] = args.filter((arg) => arg !== "--");
  if (subcommand !== "latest") {
    throw new Error("reports requires a subcommand: latest");
  }
  const repoTarget = rest[0];
  const report = getLatestInspectionReport({ repoTarget });
  console.log(formatLatestReport(report, repoTarget));
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
