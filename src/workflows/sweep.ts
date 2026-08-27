import fs from "node:fs";
import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { completeWorkflowRun, createWorkflowRun } from "../db/index.js";
import { createMinimaxHarnessModel, type HarnessModel } from "../harness/model.js";
import { emitWorkflowProgress } from "../harness/progress.js";
import type { ToolCallRecord, WorkflowProgressEvent, WorkflowResult } from "../harness/types.js";
import { assistantText, emptyUsage, usageFromAssistant } from "../harness/usage.js";
import { withWorkflowTimeout } from "../harness/timeout.js";
import { logger } from "../logger.js";
import { gatherReadinessEvidence } from "../plugins/readiness/evidence.js";
import {
  buildReadinessInterpretationPrompt,
  readinessSweepSkill
} from "../plugins/readiness/skill.js";
import { renderReportEnvelope } from "../tools/report.js";

const DEFAULT_HARNESS_PROVIDER = "agent-ops-kit";
const MODEL_RUNTIME = "pi-ai";
const MODEL_PROVIDER = "minimax";
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;
const WORKFLOW_LOG_NAME = "readiness_sweep";

interface WorkflowSourceContext {
  source: "cli" | "discord" | "slack";
  guildId?: string;
  channelId?: string;
  threadId?: string;
  messageId?: string;
  userId?: string;
}

export async function runSweepWorkflow(
  repoPath: string,
  options: {
    model?: string;
    timeoutMs?: number;
    onProgress?: (event: WorkflowProgressEvent) => void;
    sourceContext?: WorkflowSourceContext;
    signal?: AbortSignal;
  } = {}
): Promise<WorkflowResult> {
  assertNotAborted(options.signal);
  const absoluteRepoPath = path.resolve(repoPath);
  if (!fs.existsSync(absoluteRepoPath) || !fs.statSync(absoluteRepoPath).isDirectory()) {
    throw new Error(`Repository path does not exist: ${absoluteRepoPath}`);
  }

  const modelName = options.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  const runStore = createWorkflowRun({
    repoPath: absoluteRepoPath,
    harnessProvider: DEFAULT_HARNESS_PROVIDER,
    modelRuntime: MODEL_RUNTIME,
    modelProvider: MODEL_PROVIDER,
    model: modelName,
    sourceContext: options.sourceContext ? { ...options.sourceContext } : undefined
  });
  runStore.sqlite.close();

  const reportPath = reportPathFor(absoluteRepoPath, runStore.run.id);
  const calls: ToolCallRecord[] = [];
  const workflowContext = {
    workflow_name: WORKFLOW_LOG_NAME,
    repo_name: path.basename(absoluteRepoPath),
    repo_path: absoluteRepoPath,
    task_id: runStore.task.id,
    run_id: runStore.run.id,
    harness_provider: DEFAULT_HARNESS_PROVIDER,
    model_runtime: MODEL_RUNTIME,
    model_provider: MODEL_PROVIDER,
    model: modelName,
    source: options.sourceContext?.source,
    source_channel_id: options.sourceContext?.channelId,
    source_thread_id: options.sourceContext?.threadId,
    source_message_id: options.sourceContext?.messageId,
    source_user_id: options.sourceContext?.userId
  };
  const workflowLogger = logger.child(workflowContext);

  workflowLogger.info({ timeout_ms: timeoutMs }, "readiness_sweep.started");
  emitProgress(options.onProgress, {
    type: "started",
    runId: runStore.run.id,
    repoPath: absoluteRepoPath,
    model: modelName,
    timeoutMs
  });

  emitProgress(options.onProgress, { type: "evidence_started" });
  const evidence = gatherReadinessEvidence(absoluteRepoPath);
  assertNotAborted(options.signal);
  calls.push({
    name: "gather_readiness_evidence",
    args: { plugin: evidence.plugin, recipe: evidence.evidence_recipe },
    isError: false,
    result: evidence
  });
  emitProgress(options.onProgress, {
    type: "evidence_completed",
    fileCount: countedEvidenceFiles(evidence)
  });

  if (!process.env[MINIMAX_API_KEY_ENV]) {
    assertNotAborted(options.signal);
    const markdown = renderReportEnvelope(
      absoluteRepoPath,
      `## Overall Judgment

Repository evidence was collected, but LLM interpretation was skipped because \`${MINIMAX_API_KEY_ENV}\` is not set.

## Next Step

Set \`${MINIMAX_API_KEY_ENV}\` and rerun the sweep.`
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, markdown, "utf8");
    completeWorkflowRun({
      repoPath: absoluteRepoPath,
      runId: runStore.run.id,
      taskId: runStore.task.id,
      status: "skipped",
      harnessProvider: DEFAULT_HARNESS_PROVIDER,
      modelRuntime: MODEL_RUNTIME,
      modelProvider: MODEL_PROVIDER,
      model: modelName,
      summary: "Sweep interpretation skipped because MiniMax credentials are not configured.",
      reportPath,
      calls
    });
    workflowLogger.warn(
      { status: "skipped", reason: `missing_${MINIMAX_API_KEY_ENV}` },
      "readiness_sweep.skipped"
    );
    return {
      repoPath: absoluteRepoPath,
      runId: runStore.run.id,
      reportPath,
      status: "skipped",
      provider: DEFAULT_HARNESS_PROVIDER,
      model: modelName,
      usage: emptyUsage(),
      toolCalls: calls,
      error: `missing_${MINIMAX_API_KEY_ENV.toLowerCase()}`
    };
  }

  let workflowError: string | undefined;
  let interpretation: AssistantMessage | undefined;
  try {
    const harnessModel = createMinimaxHarnessModel(modelName);
    emitProgress(options.onProgress, {
      type: "model_started",
      modelProvider: harnessModel.modelProvider,
      modelRuntime: harnessModel.modelRuntime,
      model: modelName
    });
    interpretation = await interpretEvidence({
      harnessModel,
      repoPath: absoluteRepoPath,
      evidence,
      timeoutMs,
      onProgress: options.onProgress,
      signal: options.signal
    });
    workflowLogger.info(
      {
        model_provider: harnessModel.modelProvider,
        model_runtime: harnessModel.modelRuntime,
        token_count: interpretation.usage.totalTokens
      },
      "readiness_sweep.model_completed"
    );
    assertNotAborted(options.signal);
  } catch (error) {
    if (isAbortError(error)) {
      workflowLogger.warn({ status: "aborted" }, "readiness_sweep.aborted");
      throw error;
    }
    workflowError = error instanceof Error ? error.message : String(error);
    workflowLogger.error(
      {
        err: error,
        error_type: error instanceof Error ? error.name : typeof error,
        error: workflowError
      },
      "readiness_sweep.failed"
    );
  }

  const interpretationText = interpretation ? assistantText(interpretation) : "";
  let reportWasWritten = false;
  if (interpretationText) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      renderReportEnvelope(absoluteRepoPath, interpretationText),
      "utf8"
    );
    reportWasWritten = true;
    emitProgress(options.onProgress, { type: "report_submitted", reportPath });
  } else if (!workflowError) {
    workflowError = "interpretation_returned_no_text";
    workflowLogger.error(
      {
        error_type: "EmptyModelResponse",
        error: workflowError
      },
      "readiness_sweep.failed"
    );
  }

  const usage = usageFromAssistant(interpretation);
  const finalOutput = interpretationText;
  const status = workflowError ? "failed" : reportWasWritten ? "completed" : "failed";

  if (!reportWasWritten) {
    const markdown = renderReportEnvelope(
      absoluteRepoPath,
      `## Overall Judgment

The workflow did not submit a report.

## Harness Output

${finalOutput || "No assistant output was produced."}

## Error

${workflowError ?? "No explicit error was recorded."}`
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, markdown, "utf8");
  }
  workflowLogger.info({ report_path: reportPath }, "readiness_sweep.report_written");

  completeWorkflowRun({
    repoPath: absoluteRepoPath,
    runId: runStore.run.id,
    taskId: runStore.task.id,
    status,
    harnessProvider: DEFAULT_HARNESS_PROVIDER,
    modelRuntime: MODEL_RUNTIME,
    modelProvider: MODEL_PROVIDER,
    model: modelName,
    summary: status === "completed" ? "Sweep workflow completed." : "Sweep workflow failed.",
    reportPath,
    calls
  });

  workflowLogger.info(
    {
      report_path: reportPath,
      status,
      token_count: usage.totalTokens,
      tool_call_count: calls.length
    },
    "readiness_sweep.completed"
  );
  emitProgress(options.onProgress, { type: "completed", status, reportPath });

  return {
    repoPath: absoluteRepoPath,
    runId: runStore.run.id,
    reportPath,
    status,
    provider: DEFAULT_HARNESS_PROVIDER,
    model: modelName,
    usage,
    toolCalls: calls,
    error: workflowError
  };
}

async function interpretEvidence(input: {
  harnessModel: HarnessModel;
  repoPath: string;
  evidence: unknown;
  timeoutMs: number;
  onProgress?: (event: WorkflowProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<AssistantMessage> {
  const completion = input.harnessModel.models.completeSimple(
    input.harnessModel.model,
    {
      systemPrompt: `${readinessSweepSkill}

Evidence gathering is already complete. Tools are unavailable. Interpret only the provided evidence packet and write the final Markdown report directly.`,
      messages: [
        {
          role: "user",
          content: buildReadinessInterpretationPrompt(input.repoPath, input.evidence),
          timestamp: Date.now()
        }
      ],
      tools: []
    },
    {
      toolChoice: "none",
      reasoning: "low",
      maxTokens: 3000,
      timeoutMs: input.timeoutMs
    }
  );
  return await withWorkflowTimeout(withAbort(completion, input.signal), input.timeoutMs, () => {
    emitProgress(input.onProgress, { type: "timeout", timeoutMs: input.timeoutMs });
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return new Error("workflow_aborted");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "workflow_aborted";
}

const emitProgress = (
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent
) => emitWorkflowProgress(WORKFLOW_LOG_NAME, onProgress, event);

function countedEvidenceFiles(evidence: {
  key_files: string[];
  docs: string[];
  tests: string[];
  ci: string[];
  likely_entrypoints: string[];
}): number {
  return new Set([
    ...evidence.key_files,
    ...evidence.docs,
    ...evidence.tests,
    ...evidence.ci,
    ...evidence.likely_entrypoints
  ]).size;
}

function reportPathFor(repoPath: string, runId: number): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    repoPath,
    ".agent-readiness",
    "reports",
    `${timestamp}-${runId}-readiness-sweep.md`
  );
}
