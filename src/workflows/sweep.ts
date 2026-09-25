import { beginInteraction } from "../harness/interaction.js";
import type { InteractionRecorder } from "../harness/interaction.js";
import { captureHistory } from "../harness/history-capture.js";
import { emitWorkflowProgress } from "../harness/progress.js";
import type { ToolCallRecord, WorkflowProgressEvent, WorkflowResult } from "../harness/types.js";
import { emptyUsage } from "../harness/usage.js";
import { combineAbortSignals } from "../harness/timeout.js";
import { logger } from "../logger.js";
import {
  collectGitHubEvidence,
  type GitHubEvidenceClientOptions
} from "../plugins/github/client.js";
import { resolveGitHubIdentityForTarget } from "../plugins/github/evidence.js";
import { renderGitHubContext } from "../plugins/github/report.js";
import {
  OssRulesClient,
  type OssRulesClientOptions
} from "../plugins/readiness/reference/client.js";
import { ensureBenchmarkReportSection } from "../plugins/readiness/reference/report.js";
import { gatherReadinessEvidence } from "../plugins/readiness/evidence.js";
import {
  buildReadinessInterpretationPrompt,
  readinessSweepSkill
} from "../plugins/readiness/skill.js";
import { renderReportEnvelope, writeSweepReport } from "../tools/report.js";
import type { ToolSourceContext } from "../tools/registry.js";
import {
  isGitUrl,
  prepareWorkspace,
  safeGitUrlForDisplay,
  workspaceSummary
} from "../workspaces/index.js";
import type { TargetRef, WorkspaceLease } from "../workspaces/index.js";
import {
  ReadinessInterpretationError,
  runReadinessInterpretation
} from "./readiness-interpretation.js";

const DEFAULT_HARNESS_PROVIDER = "agent-workflow-runtime";
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;
const DEFAULT_GITHUB_EVIDENCE_TIMEOUT_MS = 10_000;

export async function runSweepWorkflow(
  target: string | TargetRef,
  options: {
    model?: string;
    ref?: string;
    timeoutMs?: number;
    onProgress?: (event: WorkflowProgressEvent) => void;
    sourceContext?: ToolSourceContext;
    signal?: AbortSignal;
    github?: GitHubEvidenceClientOptions;
    benchmark?: OssRulesClientOptions;
    recording?: InteractionRecorder;
  } = {}
): Promise<WorkflowResult> {
  const origin =
    typeof target === "string" ? target : target.kind === "git-url" ? target.url : target.path;
  const source =
    typeof target === "string" ? (isGitUrl(target) ? "git-url" : "local-git") : target.kind;
  const displayOrigin = captureHistory(
    source === "git-url" ? safeGitUrlForDisplay(origin) : origin
  ).text;
  const requestedRef = options.ref ?? (typeof target === "string" ? undefined : target.ref);
  const recording =
    options.recording ??
    beginInteraction(
      {
        source: "cli",
        kind: "readiness_sweep",
        userMessage: {
          command: "sweep",
          target: origin,
          ...(requestedRef ? { ref: requestedRef } : {})
        },
        target: displayOrigin,
        metadata: options.sourceContext
      },
      { signal: options.signal }
    );
  const ownsInteraction = !options.recording;
  const signal = combineAbortSignals(recording.signal, options.signal)!;
  const modelName = options.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  const calls: ToolCallRecord[] = [];
  const result: WorkflowResult = {
    target: { source, origin: displayOrigin, ...(requestedRef ? { ref: requestedRef } : {}) },
    interactionId: recording.interactionId,
    runId: recording.runId,
    status: "failed",
    provider: DEFAULT_HARNESS_PROVIDER,
    model: modelName,
    usage: emptyUsage(),
    toolCalls: calls
  };
  const logContext = { interaction_id: recording.interactionId, run_id: recording.runId };
  const progress = (event: WorkflowProgressEvent) =>
    emitWorkflowProgress("readiness_sweep", options.onProgress, event, logContext);
  let lease: WorkspaceLease | undefined;
  let primaryError: unknown;
  const assertActive = () => {
    recording.assertHealthy();
    if (signal.aborted) throw new Error("workflow_aborted");
  };

  try {
    try {
      logger.info(
        { ...logContext, workflow_name: "readiness_sweep", timeout_ms: timeoutMs },
        "readiness_sweep.started"
      );
      assertActive();
      lease = await prepareWorkspace(target, options.ref, { signal });
      assertActive();
      const workspace = workspaceSummary(lease);
      const runMetadata = {
        workspace,
        ...(options.sourceContext ? { source: options.sourceContext } : {}),
        harnessProvider: DEFAULT_HARNESS_PROVIDER,
        modelProvider: "minimax",
        modelRuntime: "pi-ai",
        model: modelName
      };
      result.workspace = workspace;
      result.repoPath = lease.path;
      result.target = {
        source: lease.source,
        origin: lease.displayOrigin,
        ref: lease.ref,
        commitSha: lease.commitSha
      };
      recording.updateRun({
        target: lease.displayOrigin,
        ref: lease.ref,
        commitSha: lease.commitSha,
        metadata: runMetadata
      });
      progress({ type: "workspace_prepared", target: result.target, workspace });
      progress({
        type: "started",
        runId: recording.runId,
        repoPath: lease.path,
        model: modelName,
        timeoutMs
      });
      progress({ type: "evidence_started" });
      const readinessInput = { repoPath: lease.path };
      const evidence = recording.recordTool(
        {
          name: "gather_readiness_evidence",
          kind: "workflow",
          source: "readiness",
          input: readinessInput
        },
        () => gatherReadinessEvidence(lease!.path),
        signal
      );
      calls.push({
        name: "gather_readiness_evidence",
        args: readinessInput,
        isError: false,
        result: evidence
      });
      assertActive();
      const ossRulesClient = new OssRulesClient({
        ...options.benchmark,
        signal: combineAbortSignals(signal, options.benchmark?.signal)
      });
      progress({ type: "benchmark_started" });
      const benchmarkStartedAt = Date.now();
      const benchmarkInput = { endpoint: "/catalog" };
      const benchmark = await recording.recordTool(
        {
          name: "rules_benchmark_catalog",
          kind: "workflow",
          source: "readiness",
          input: benchmarkInput
        },
        () => ossRulesClient.catalog(),
        signal
      );
      calls.push({
        name: "rules_benchmark_catalog",
        args: benchmarkInput,
        isError: false,
        result: benchmark
      });
      result.benchmark = {
        status: benchmark.status,
        apiVersion: benchmark.provenance.api_version,
        endpoint: benchmark.provenance.endpoint,
        fetchedAt: benchmark.provenance.fetched_at,
        ...(benchmark.provenance.cache_age_ms === undefined
          ? {}
          : { cacheAgeMs: benchmark.provenance.cache_age_ms }),
        ...(benchmark.unavailable_reason ? { reason: benchmark.unavailable_reason } : {})
      };
      recording.updateRun({ metadata: { ...runMetadata, benchmark: result.benchmark } });
      progress({
        type: "benchmark_completed",
        status: benchmark.status,
        durationMs: Math.max(0, Date.now() - benchmarkStartedAt),
        cacheAgeMs: benchmark.provenance.cache_age_ms,
        failureType: benchmark.unavailable_reason
      });
      assertActive();
      // Avoid counting a non-GitHub target as a second evidence collection.
      const githubIdentity = await resolveGitHubIdentityForTarget(workspace.origin, {
        signal
      });
      const githubInput = { target: githubIdentity?.full_name };
      const github = githubIdentity
        ? await recording.recordTool(
            {
              name: "gather_github_evidence",
              kind: "workflow",
              source: "github",
              input: githubInput
            },
            (_recording, evidenceSignal) =>
              collectGitHubEvidence(githubIdentity, {
                ...options.github,
                useAmbientToken:
                  options.github?.useAmbientToken ??
                  (!options.sourceContext || options.sourceContext.source === "cli"),
                signal: combineAbortSignals(evidenceSignal, options.github?.signal),
                timeoutMs: Math.min(
                  options.github?.timeoutMs ?? DEFAULT_GITHUB_EVIDENCE_TIMEOUT_MS,
                  timeoutMs
                )
              }),
            signal
          )
        : undefined;
      if (github)
        calls.push({
          name: "gather_github_evidence",
          args: githubInput,
          isError: false,
          result: github
        });
      assertActive();
      progress({
        type: "evidence_completed",
        fileCount: new Set([
          ...evidence.key_files,
          ...evidence.docs,
          ...evidence.tests,
          ...evidence.ci,
          ...evidence.likely_entrypoints
        ]).size
      });
      const context = renderGitHubContext(github);
      let body: string;
      if (!process.env.MINIMAX_API_KEY) {
        result.status = "skipped";
        result.error = "missing_minimax_api_key";
        body = ensureBenchmarkReportSection(
          "## Overall Judgment\n\nRepository evidence was collected, but LLM interpretation was skipped because `MINIMAX_API_KEY` is not set.\n\n## Next Step\n\nSet `MINIMAX_API_KEY` and rerun the sweep.",
          benchmark
        );
      } else {
        assertActive();
        progress({
          type: "model_started",
          modelProvider: "minimax",
          modelRuntime: "pi-ai",
          model: modelName
        });
        assertActive();
        const interpretation = await runReadinessInterpretation({
          modelName,
          timeoutMs,
          signal,
          recording,
          ossRulesClient,
          sourceContext: options.sourceContext,
          onProgress: progress,
          systemPrompt: readinessSweepSkill,
          prompt: buildReadinessInterpretationPrompt(lease.path, {
            readiness: evidence,
            ...(github ? { github } : {}),
            rules_benchmark: benchmark
          })
        }).catch((error: unknown) => {
          if (error instanceof ReadinessInterpretationError) {
            result.usage = error.usage;
            calls.push(...error.toolCalls);
          }
          throw error;
        });
        result.usage = interpretation.usage;
        calls.push(...interpretation.toolCalls);
        logger.info(
          {
            ...logContext,
            model_provider: "minimax",
            model_runtime: "pi-ai",
            model: modelName,
            token_count: result.usage.totalTokens
          },
          "readiness_sweep.model_completed"
        );
        body = ensureBenchmarkReportSection(interpretation.body, benchmark);
        result.status = "completed";
      }
      assertActive();
      const reportPath = writeSweepReport(
        recording.runId,
        renderReportEnvelope(lease.path, body, {
          workspace,
          contextSections: context ? [context] : []
        })
      );
      recording.registerArtifact({ path: reportPath, type: "markdown", title: "Readiness sweep" });
      result.reportPath = reportPath;
      logger.info({ ...logContext, report_path: reportPath }, "readiness_sweep.report_written");
      progress({ type: "report_submitted", reportPath });
      assertActive();
    } catch (error) {
      primaryError = error;
      result.status = signal.aborted ? "cancelled" : "failed";
      result.error = safeError(error);
    } finally {
      // Cleanup must run even when cancellation or the fatal recording latch prevents new work.
      if (lease) {
        try {
          await lease.cleanup();
        } catch (error) {
          result.cleanupError = safeError(error);
          logger.error(
            { ...logContext, error: result.cleanupError },
            "readiness_sweep.cleanup_failed"
          );
          if (!primaryError) {
            primaryError = error;
            result.error = result.cleanupError;
            result.status = "failed";
          }
        }
      }
    }
    recording.assertHealthy();
    if (signal.aborted && !primaryError) {
      result.status = "cancelled";
      result.error = "workflow_aborted";
    }
    const error = result.cleanupError
      ? { message: result.error, cleanupError: result.cleanupError }
      : result.error;
    recording.finishRun({ status: result.status, error });
    if (ownsInteraction) {
      recording.appendMessage({
        role: "assistant",
        content: {
          status: result.status,
          target: result.target,
          ...(result.reportPath ? { reportPath: result.reportPath } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.cleanupError ? { cleanupError: result.cleanupError } : {})
        }
      });
      recording.finishInteraction({ status: result.status, error });
    }
    recording.assertHealthy();
    if (result.status === "failed" || result.status === "cancelled") {
      logger.error(
        {
          ...logContext,
          status: result.status,
          error: result.error,
          error_type:
            primaryError instanceof Error ? captureHistory(primaryError.name).text : "WorkflowError"
        },
        "readiness_sweep.failed"
      );
    }
    logger.info(
      {
        ...logContext,
        status: result.status,
        report_path: result.reportPath,
        token_count: result.usage.totalTokens,
        workflow_activity_count: calls.length
      },
      "readiness_sweep.completed"
    );
    progress({ type: "completed", status: result.status, reportPath: result.reportPath });
    return result;
  } finally {
    if (ownsInteraction) recording.close();
  }
}

function safeError(error: unknown): string {
  return captureHistory(error instanceof Error ? error.message : String(error)).text;
}
