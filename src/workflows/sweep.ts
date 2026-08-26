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
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;
const WORKFLOW_LOG_NAME = "readiness_sweep";

export async function runSweepWorkflow(
  repoPath: string,
  options: {
    model?: string;
    timeoutMs?: number;
    onProgress?: (event: WorkflowProgressEvent) => void;
  } = {}
): Promise<WorkflowResult> {
  const absoluteRepoPath = path.resolve(repoPath);
  if (!fs.existsSync(absoluteRepoPath) || !fs.statSync(absoluteRepoPath).isDirectory()) {
    throw new Error(`Repository path does not exist: ${absoluteRepoPath}`);
  }

  const modelName = options.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  const runStore = createWorkflowRun(absoluteRepoPath, DEFAULT_HARNESS_PROVIDER, modelName);
  runStore.sqlite.close();

  const reportPath = reportPathFor(absoluteRepoPath, runStore.run.id);
  const calls: ToolCallRecord[] = [];
  const workflowContext = {
    workflow_name: WORKFLOW_LOG_NAME,
    repo_name: path.basename(absoluteRepoPath),
    repo_path: absoluteRepoPath,
    task_id: runStore.task.id,
    run_id: runStore.run.id,
    provider: DEFAULT_HARNESS_PROVIDER,
    model: modelName
  };

  logger.info({ ...workflowContext, timeout_ms: timeoutMs }, "readiness_sweep.started");
  emitProgress(options.onProgress, {
    type: "started",
    runId: runStore.run.id,
    repoPath: absoluteRepoPath,
    model: modelName,
    timeoutMs
  });

  emitProgress(options.onProgress, { type: "evidence_started" });
  const evidence = gatherReadinessEvidence(absoluteRepoPath);
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
      summary: "Sweep interpretation skipped because MiniMax credentials are not configured.",
      reportPath,
      calls
    });
    logger.warn(
      { ...workflowContext, status: "skipped", reason: `missing_${MINIMAX_API_KEY_ENV}` },
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
      provider: harnessModel.provider,
      model: modelName
    });
    interpretation = await interpretEvidence({
      harnessModel,
      repoPath: absoluteRepoPath,
      evidence,
      timeoutMs,
      onProgress: options.onProgress
    });
    logger.info(
      {
        ...workflowContext,
        provider: harnessModel.provider,
        token_count: interpretation.usage.totalTokens
      },
      "readiness_sweep.model_completed"
    );
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        ...workflowContext,
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
    logger.error(
      {
        ...workflowContext,
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
  logger.info({ ...workflowContext, report_path: reportPath }, "readiness_sweep.report_written");

  completeWorkflowRun({
    repoPath: absoluteRepoPath,
    runId: runStore.run.id,
    taskId: runStore.task.id,
    status,
    summary: status === "completed" ? "Sweep workflow completed." : "Sweep workflow failed.",
    reportPath,
    calls
  });

  logger.info(
    {
      ...workflowContext,
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
}): Promise<AssistantMessage> {
  return await withWorkflowTimeout(
    input.harnessModel.models.completeSimple(
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
    ),
    input.timeoutMs,
    () => {
      emitProgress(input.onProgress, { type: "timeout", timeoutMs: input.timeoutMs });
    }
  );
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
