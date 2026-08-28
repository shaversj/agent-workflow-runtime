import fs from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import {
  defineRegisteredTool,
  type RegisteredTool,
  type RegisteredToolContext
} from "../../tools/registry.js";
import {
  normalizedTargetRef,
  parseTargetRef,
  safeGitUrlForDisplay,
  targetStatePath
} from "../../workspaces/index.js";

const PLUGIN_NAME = "readiness";
const READINESS_TOOL_SOURCE = {
  id: PLUGIN_NAME,
  label: "Readiness",
  description: "Repository readiness workflows and report inspection tools."
};

const RunSweepParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({
      description:
        "Repository target path or Git URL. Omit when the chat surface has a default repo."
    })
  ),
  ref: Type.Optional(
    Type.String({ description: "Git ref to sweep, such as main or a commit SHA." })
  ),
  model: Type.Optional(Type.String({ description: "Model name for interpretation." })),
  timeout_ms: Type.Optional(
    Type.Number({ minimum: 1, description: "Workflow timeout in milliseconds." })
  )
});

const GetLatestReportParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({
      description:
        "Repository target path or Git URL. Omit when the chat surface has a default repo."
    })
  )
});

const ReadReportParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({
      description:
        "Repository target path or Git URL. Omit when the chat surface has a default repo."
    })
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
    source: READINESS_TOOL_SOURCE,
    exposure: "deferred",
    readOnly: false,
    requiresApproval: false,
    allowedSurfaces: ["discord", "slack"],
    async execute(
      params: RunSweepParamsType,
      context: RegisteredToolContext,
      signal?: AbortSignal
    ) {
      const repoTarget = resolveRepoTarget(params.repo_path, context);
      const result = await runSweepWorkflow(repoTarget, {
        ref: params.ref,
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
    source: READINESS_TOOL_SOURCE,
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord", "slack"],
    execute(params: GetLatestReportParamsType, context: RegisteredToolContext) {
      const repoTarget = resolveRepoTarget(params.repo_path, context);
      const statePath = statePathForTarget(repoTarget);
      const displayTarget = displayRepoTarget(repoTarget);
      const report = latestReport(statePath);
      const result = report
        ? {
            repo_path: displayTarget,
            report_path: report.path,
            bytes: report.bytes,
            updated_at: report.updatedAt
          }
        : { repo_path: displayTarget, report_path: undefined, bytes: 0, updated_at: undefined };
      return {
        result,
        text: report
          ? `Latest readiness report: ${report.path}`
          : `No readiness reports were found for ${displayTarget}.`,
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
    source: READINESS_TOOL_SOURCE,
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord", "slack"],
    execute(params: ReadReportParamsType, context: RegisteredToolContext) {
      const repoTarget = resolveRepoTarget(params.repo_path, context);
      const statePath = statePathForTarget(repoTarget);
      const displayTarget = displayRepoTarget(repoTarget);
      const reportPath = resolveReportPath(statePath, displayTarget, params.report_path);
      const maxBytes = params.max_bytes ?? 12000;
      const raw = fs.readFileSync(reportPath);
      const truncated = raw.byteLength > maxBytes;
      const content = raw.subarray(0, maxBytes).toString("utf8");
      const result = {
        repo_path: displayTarget,
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

function resolveRepoTarget(repoTarget: string | undefined, context: RegisteredToolContext): string {
  const resolved = repoTarget ?? context.defaultRepoPath;
  if (!resolved) {
    throw new Error("Repository target is required.");
  }
  return resolved;
}

function statePathForTarget(repoTarget: string): string {
  const target = normalizedTargetRef(parseTargetRef(repoTarget));
  return targetStatePath(target);
}

function displayRepoTarget(repoTarget: string): string {
  const target = parseTargetRef(repoTarget);
  return target.kind === "git-url" ? safeGitUrlForDisplay(target.url) : path.resolve(target.path);
}

function latestReport(
  statePath: string
): { path: string; bytes: number; updatedAt: string } | undefined {
  const reportDir = path.join(statePath, "reports");
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

function resolveReportPath(
  statePath: string,
  repoTarget: string,
  requestedPath: string | undefined
): string {
  if (!requestedPath) {
    const report = latestReport(statePath);
    if (!report) throw new Error(`No readiness reports were found for ${repoTarget}.`);
    return report.path;
  }

  const candidatePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(statePath, "reports", requestedPath);
  const reportDir = path.join(statePath, "reports");
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) {
    throw new Error(`No readiness reports were found for ${repoTarget}.`);
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
      target: result.target.origin,
      workspace_path: result.workspace?.path ?? result.repoPath,
      run_id: result.runId,
      status: result.status,
      report_path: result.reportPath,
      ref: result.target.ref,
      commit_sha: result.target.commitSha,
      token_count: result.usage.totalTokens,
      tool_call_count: result.toolCalls.length,
      error: result.error
    },
    null,
    2
  );
}
