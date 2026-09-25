import path from "node:path";

import { Type, type Static } from "typebox";

import {
  InspectionLatestReportResultSchema,
  InspectionReadReportResultSchema,
  InspectionRunListResultSchema,
  InspectionRunShowResultSchema,
  WorkflowResultSchema
} from "../../harness/schemas.js";
import {
  getLatestInspectionReport,
  displayInspectionTarget,
  listInspectionRuns,
  readInspectionReport,
  showInspectionRun,
  type InspectionRunListResult,
  type InspectionRunShowResult
} from "../../db/inspection.js";
import { DEFAULT_HARNESS_MODEL, runSweepWorkflow } from "../../workflows/sweep.js";
import { resolveAuthenticatedRequestTarget } from "../../surfaces/chat/request-context.js";
import { definePlugin } from "../manifest.js";
import { readinessPluginManifest } from "./manifest.js";
import { createReadinessReferenceTools } from "./reference/tools.js";
import {
  defineRegisteredTool,
  type RegisteredTool,
  type RegisteredToolContext
} from "../../tools/registry.js";

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

const ListRunsParams = Type.Object({
  repo_path: Type.Optional(
    Type.String({
      description:
        "Repository target path or Git URL. Required from chat surfaces unless the surface has a default repo."
    })
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 }))
});

const ShowRunParams = Type.Object({
  run_ref: Type.String({
    description:
      "Global positive integer run ID. Chat requests also need a repository target or configured default."
  }),
  repo_path: Type.Optional(
    Type.String({
      description:
        "Repository target path or Git URL. Required for bare run IDs from chat surfaces."
    })
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
type ListRunsParamsType = Static<typeof ListRunsParams>;
type ShowRunParamsType = Static<typeof ShowRunParams>;
type GetLatestReportParamsType = Static<typeof GetLatestReportParams>;
type ReadReportParamsType = Static<typeof ReadReportParams>;

const readinessPlugin = definePlugin({
  manifest: readinessPluginManifest,
  tools: [
    defineRegisteredTool({
      pluginName: readinessPluginManifest.name,
      name: "list_runs",
      label: "List Readiness Runs",
      description:
        "List recent readiness sweep runs from managed Agent Workflow Runtime state without reading repository files.",
      parameters: ListRunsParams,
      resultSchema: InspectionRunListResultSchema,
      execute(params: ListRunsParamsType, context: RegisteredToolContext) {
        const repoTarget = resolveRepoTargetForRemote(params.repo_path, context);
        const result = listInspectionRuns({ repoTarget, limit: params.limit });
        return {
          result,
          text: renderRunListText(result.runs),
          terminate: false
        };
      }
    }),
    defineRegisteredTool({
      pluginName: readinessPluginManifest.name,
      name: "show_run",
      label: "Show Readiness Run",
      description:
        "Show one readiness sweep run from managed Agent Workflow Runtime state without reading repository files.",
      parameters: ShowRunParams,
      resultSchema: InspectionRunShowResultSchema,
      execute(params: ShowRunParamsType, context: RegisteredToolContext) {
        const repoTarget = resolveRepoTargetForRemote(params.repo_path, context);
        const result = showInspectionRun(params.run_ref, { repoTarget });
        return {
          result,
          text: renderRunShowText(result),
          terminate: false
        };
      }
    }),
    defineRegisteredTool({
      pluginName: readinessPluginManifest.name,
      name: "run_sweep",
      label: "Run Readiness Sweep",
      description:
        "Run the readiness sweep for a repository, gather evidence, ask the model to interpret it, and write the Markdown report.",
      parameters: RunSweepParams,
      resultSchema: WorkflowResultSchema,
      async execute(
        params: RunSweepParamsType,
        context: RegisteredToolContext,
        signal?: AbortSignal
      ) {
        const repoTarget = resolveRepoTarget(params.repo_path, context);
        const recording = context.recording?.childRun({
          kind: "readiness_sweep",
          target: repoTarget,
          ref: params.ref
        });
        try {
          const result = await runSweepWorkflow(repoTarget, {
            ref: params.ref,
            model: params.model ?? context.model ?? DEFAULT_HARNESS_MODEL,
            timeoutMs: params.timeout_ms ?? context.timeoutMs,
            onProgress: context.onProgress,
            sourceContext: context.sourceContext,
            signal,
            recording,
            github: {
              useAmbientToken:
                context.surface === "cli" ||
                (!params.repo_path &&
                  Boolean(
                    context.requestContext?.repoTarget && !context.requestContext.explicitRepoTarget
                  ))
            }
          });
          return {
            result,
            text: renderSweepToolText(result),
            terminate: true
          };
        } finally {
          recording?.close();
        }
      }
    }),
    defineRegisteredTool({
      pluginName: readinessPluginManifest.name,
      name: "get_latest_report",
      label: "Get Latest Readiness Report",
      description:
        "Return metadata for the newest readiness report in the repository without reading the full report body.",
      parameters: GetLatestReportParams,
      resultSchema: InspectionLatestReportResultSchema,
      execute(params: GetLatestReportParamsType, context: RegisteredToolContext) {
        const repoTarget = resolveRepoTarget(params.repo_path, context);
        const report = getLatestInspectionReport({ repoTarget });
        const result = report
          ? {
              repo_path: report.target,
              report_path: report.report_path,
              bytes: report.bytes,
              updated_at: report.updated_at,
              run_ref: report.run_ref,
              status: report.status,
              token_count: report.token_count,
              tool_call_count: report.tool_call_count,
              benchmark_status: report.benchmark_status,
              failure_reason: report.failure_reason
            }
          : { repo_path: displayInspectionTarget(repoTarget), bytes: 0 };
        return {
          result,
          text: report
            ? `Latest readiness report: ${report.report_path}`
            : `No readiness reports were found for ${displayInspectionTarget(repoTarget)}.`,
          terminate: false
        };
      }
    }),
    defineRegisteredTool({
      pluginName: readinessPluginManifest.name,
      name: "read_report",
      label: "Read Readiness Report",
      description:
        "Read a readiness report body. Use this when the user asks to show, summarize, or inspect an existing report.",
      parameters: ReadReportParams,
      resultSchema: InspectionReadReportResultSchema,
      execute(params: ReadReportParamsType, context: RegisteredToolContext) {
        const repoTarget = resolveRepoTarget(params.repo_path, context);
        const result = readInspectionReport({
          repoTarget,
          reportPath: params.report_path,
          maxBytes: params.max_bytes
        });
        return {
          result,
          text: JSON.stringify(result, null, 2),
          terminate: false
        };
      }
    }),
    ...createReadinessReferenceTools()
  ]
});

export const readinessTools: RegisteredTool[] = readinessPlugin.tools.filter(
  (tool) => tool.exposure !== "hidden"
);

export const readinessReferenceTools: RegisteredTool[] = readinessPlugin.tools.filter(
  (tool) => tool.exposure === "hidden"
);

function resolveRepoTarget(repoTarget: string | undefined, context: RegisteredToolContext): string {
  if (context.surface === "discord" || context.surface === "slack") {
    const target = context.requestContext
      ? resolveAuthenticatedRequestTarget(context.requestContext, repoTarget)
      : undefined;
    if (!target) throw new Error("Repository target is required.");
    return target.kind === "git-url" ? target.url : target.path;
  }
  const resolved = repoTarget ?? context.requestContext?.repoTarget;
  if (!resolved) {
    throw new Error("Repository target is required.");
  }
  return resolved;
}

function resolveRepoTargetForRemote(
  repoTarget: string | undefined,
  context: RegisteredToolContext
): string | undefined {
  if (context.surface === "cli") return repoTarget ?? context.requestContext?.repoTarget;
  return resolveRepoTarget(repoTarget, context);
}

function renderRunListText(runs: InspectionRunListResult["runs"]): string {
  if (!runs.length) return "No readiness sweep runs were found.";
  return runs
    .map(
      (run) =>
        `${run.run_ref} status=${run.status} target=${shortTarget(run.target)} ref=${run.ref ?? "unknown"} commit=${run.short_commit ?? "unknown"} benchmark=${run.benchmark_status ?? "unknown"} tokens=${run.token_count ?? "unknown"} tools=${run.tool_call_count} report=${run.report_path ? path.basename(run.report_path) : "none"}${run.failure_reason ? ` failure=${run.failure_reason}` : ""}`
    )
    .join("\n");
}

function renderRunShowText(result: InspectionRunShowResult): string {
  if (!result.found) return result.reason;
  const run = result.run;
  const lines = [
    `Run: ${run.run_ref}`,
    `Status: ${run.status}`,
    `Target: ${run.target}`,
    `Ref: ${run.ref ?? "unknown"}`,
    `Commit: ${run.short_commit ?? "unknown"}`,
    `Rules benchmark: ${run.benchmark_status ?? "unknown"}`,
    `Report: ${run.report_path ?? "none"}`,
    `Tokens: ${run.token_count ?? "unknown"}`,
    `Tool calls: ${run.tool_call_count}`
  ];
  if (run.failure_reason) lines.push(`Failure reason: ${run.failure_reason}`);
  return lines.join("\n");
}

function shortTarget(target: string): string {
  return target.startsWith("http") ? target : path.basename(target);
}

function renderSweepToolText(result: Awaited<ReturnType<typeof runSweepWorkflow>>): string {
  return JSON.stringify(
    {
      target: result.target.origin,
      workspace_path: result.workspace?.path ?? result.repoPath,
      run_id: result.runId,
      status: result.status,
      report_path: result.reportPath ?? null,
      ref: result.target.ref,
      commit_sha: result.target.commitSha,
      benchmark_status: result.benchmark?.status ?? null,
      token_count: result.usage.totalTokens ?? null,
      usage_completeness: result.usage.completeness ?? "unknown",
      workflow_activity_count: result.toolCalls.length,
      error: result.error
    },
    null,
    2
  );
}
