import fs from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import {
  defineRegisteredTool,
  type RegisteredTool,
  type RegisteredToolContext
} from "../../tools/registry.js";

const PLUGIN_NAME = "readiness";

const RunSweepParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({ description: "Repository path. Omit when the chat surface has a default repo." })
  ),
  model: Type.Optional(Type.String({ description: "Model name for interpretation." })),
  timeout_ms: Type.Optional(
    Type.Number({ minimum: 1, description: "Workflow timeout in milliseconds." })
  )
});

const GetLatestReportParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({ description: "Repository path. Omit when the chat surface has a default repo." })
  )
});

const ReadReportParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({ description: "Repository path. Omit when the chat surface has a default repo." })
  ),
  report_path: Type.Optional(
    Type.String({
      description: "Absolute or repo-relative Markdown report path. Omit to read the latest report."
    })
  ),
  max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 50000, default: 12000 }))
});

type RunSweepParamsType = Static<typeof RunSweepParams>;
type GetLatestReportParamsType = Static<typeof GetLatestReportParams>;
type ReadReportParamsType = Static<typeof ReadReportParams>;

export const readinessTools: RegisteredTool[] = [
  defineRegisteredTool({
    pluginName: PLUGIN_NAME,
    name: "run_sweep",
    label: "Run Readiness Sweep",
    description:
      "Run the readiness sweep for a repository, gather evidence, ask the model to interpret it, and write the Markdown report.",
    parameters: RunSweepParams,
    allowedSurfaces: ["discord", "slack"],
    async execute(
      params: RunSweepParamsType,
      context: RegisteredToolContext,
      signal?: AbortSignal
    ) {
      const repoPath = resolveRepoPath(params.repo_path, context);
      const result = await runSweepWorkflow(repoPath, {
        model: params.model ?? context.model ?? DEFAULT_HARNESS_MODEL,
        timeoutMs: params.timeout_ms ?? context.timeoutMs,
        onProgress: context.onProgress,
        sourceContext: context.sourceContext,
        signal
      });
      return {
        result,
        text: renderSweepToolText(result),
        terminate: true
      };
    }
  }),
  defineRegisteredTool({
    pluginName: PLUGIN_NAME,
    name: "get_latest_report",
    label: "Get Latest Readiness Report",
    description:
      "Return metadata for the newest readiness report in the repository without reading the full report body.",
    parameters: GetLatestReportParams,
    allowedSurfaces: ["discord", "slack"],
    execute(params: GetLatestReportParamsType, context: RegisteredToolContext) {
      const repoPath = resolveRepoPath(params.repo_path, context);
      const report = latestReport(repoPath);
      const result = report
        ? {
            repo_path: repoPath,
            report_path: report.path,
            bytes: report.bytes,
            updated_at: report.updatedAt
          }
        : { repo_path: repoPath, report_path: undefined, bytes: 0, updated_at: undefined };
      return {
        result,
        text: report
          ? `Latest readiness report: ${report.path}`
          : `No readiness reports were found for ${repoPath}.`,
        terminate: false
      };
    }
  }),
  defineRegisteredTool({
    pluginName: PLUGIN_NAME,
    name: "read_report",
    label: "Read Readiness Report",
    description:
      "Read a readiness report body. Use this when the user asks to show, summarize, or inspect an existing report.",
    parameters: ReadReportParams,
    allowedSurfaces: ["discord", "slack"],
    execute(params: ReadReportParamsType, context: RegisteredToolContext) {
      const repoPath = resolveRepoPath(params.repo_path, context);
      const reportPath = resolveReportPath(repoPath, params.report_path);
      const maxBytes = params.max_bytes ?? 12000;
      const raw = fs.readFileSync(reportPath);
      const truncated = raw.byteLength > maxBytes;
      const content = raw.subarray(0, maxBytes).toString("utf8");
      const result = {
        repo_path: repoPath,
        report_path: reportPath,
        content,
        truncated
      };
      return {
        result,
        text: JSON.stringify(result, null, 2),
        terminate: false
      };
    }
  })
];

function resolveRepoPath(repoPath: string | undefined, context: RegisteredToolContext): string {
  const resolved = path.resolve(repoPath ?? context.defaultRepoPath ?? "");
  if (!repoPath && !context.defaultRepoPath) {
    throw new Error("Repository path is required.");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository path does not exist: ${resolved}`);
  }
  return resolved;
}

function latestReport(
  repoPath: string
): { path: string; bytes: number; updatedAt: string } | undefined {
  const reportDir = path.join(repoPath, ".agent-readiness", "reports");
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return undefined;
  const realReportDir = fs.realpathSync(reportDir);
  const reports = fs
    .readdirSync(reportDir)
    .filter((entry) => entry.endsWith(".md"))
    .flatMap((entry) => {
      const reportPath = safeReportPath(realReportDir, path.join(reportDir, entry));
      if (!reportPath) return [];
      const stat = fs.statSync(reportPath);
      return { path: reportPath, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const report = reports[0];
  if (!report) return undefined;
  return {
    path: report.path,
    bytes: report.bytes,
    updatedAt: new Date(report.mtimeMs).toISOString()
  };
}

function resolveReportPath(repoPath: string, requestedPath: string | undefined): string {
  if (!requestedPath) {
    const report = latestReport(repoPath);
    if (!report) throw new Error(`No readiness reports were found for ${repoPath}.`);
    return report.path;
  }

  const candidatePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(repoPath, requestedPath);
  const reportDir = path.join(repoPath, ".agent-readiness", "reports");
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) {
    throw new Error(`No readiness reports were found for ${repoPath}.`);
  }
  const realReportDir = fs.realpathSync(reportDir);
  const reportPath = safeReportPath(realReportDir, candidatePath);
  if (!reportPath) {
    throw new Error(`Report path is outside the readiness reports directory: ${requestedPath}`);
  }
  return reportPath;
}

function safeReportPath(realReportDir: string, candidatePath: string): string | undefined {
  if (!fs.existsSync(candidatePath)) return undefined;
  const realCandidatePath = fs.realpathSync(candidatePath);
  const relativePath = path.relative(realReportDir, realCandidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  if (!fs.statSync(realCandidatePath).isFile()) return undefined;
  return realCandidatePath;
}

function renderSweepToolText(result: Awaited<ReturnType<typeof runSweepWorkflow>>): string {
  return JSON.stringify(
    {
      repo_path: result.repoPath,
      run_id: result.runId,
      status: result.status,
      report_path: result.reportPath,
      token_count: result.usage.totalTokens,
      tool_call_count: result.toolCalls.length,
      error: result.error
    },
    null,
    2
  );
}
