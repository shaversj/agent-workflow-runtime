import fs from "node:fs";
import path from "node:path";

import {
  type AssistantMessage,
  createModels,
  type Api,
  type Model,
  type MutableModels
} from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";

import { collectReadinessEvidence } from "../collection/readiness.js";
import { completeWorkflowRun, createWorkflowRun } from "../db/index.js";
import type {
  HarnessUsage,
  ToolCallRecord,
  WorkflowProgressEvent,
  WorkflowResult
} from "../domain/types.js";
import { logger } from "../logger.js";
import {
  buildReadinessInterpretationPrompt,
  readinessSweepSkill
} from "../skills/readiness-sweep.js";
import { renderReportEnvelope } from "../tools/report.js";

const DEFAULT_HARNESS_PROVIDER = "agent-ops-kit";
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;

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

  logger.info({ repo_path: absoluteRepoPath, run_id: runStore.run.id }, "readiness_sweep.started");
  emitProgress(options.onProgress, {
    type: "started",
    runId: runStore.run.id,
    repoPath: absoluteRepoPath,
    model: modelName,
    timeoutMs
  });

  emitProgress(options.onProgress, { type: "collection_started" });
  const evidence = collectReadinessEvidence(absoluteRepoPath);
  calls.push({
    name: "collect_readiness_evidence",
    args: { skill: evidence.collection_skill },
    isError: false,
    result: evidence
  });
  emitProgress(options.onProgress, {
    type: "collection_completed",
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

  const models = createModels();
  models.setProvider(minimaxProvider());
  const model = models.getModel("minimax", modelName);
  if (!model) {
    throw new Error(`MiniMax model is not available through pi-ai: ${modelName}`);
  }

  let workflowError: string | undefined;
  let interpretation: AssistantMessage | undefined;
  try {
    emitProgress(options.onProgress, {
      type: "model_started",
      provider: "minimax",
      model: modelName
    });
    interpretation = await interpretEvidence({
      models,
      model,
      repoPath: absoluteRepoPath,
      evidence,
      timeoutMs,
      onProgress: options.onProgress
    });
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
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
    { repo_path: absoluteRepoPath, run_id: runStore.run.id, report_path: reportPath, status },
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
  models: MutableModels;
  model: Model<Api>;
  repoPath: string;
  evidence: unknown;
  timeoutMs: number;
  onProgress?: (event: WorkflowProgressEvent) => void;
}): Promise<AssistantMessage> {
  return await withWorkflowTimeout(
    input.models.completeSimple(
      input.model,
      {
        systemPrompt: `${readinessSweepSkill}

Collection is already complete. Tools are unavailable. Interpret only the provided evidence packet and write the final Markdown report directly.`,
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

async function withWorkflowTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error(`workflow_timeout:${timeoutMs}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function emitProgress(
  onProgress: ((event: WorkflowProgressEvent) => void) | undefined,
  event: WorkflowProgressEvent
) {
  onProgress?.(event);
  if (event.type === "tool_started") {
    logger.info({ tool_name: event.name }, "readiness_sweep.tool_started");
  } else if (event.type === "tool_completed") {
    logger.info(
      { tool_name: event.name, is_error: event.isError },
      "readiness_sweep.tool_completed"
    );
  } else if (event.type === "turn_started") {
    logger.info({ turn: event.turn }, "readiness_sweep.turn_started");
  } else if (event.type === "timeout") {
    logger.warn({ timeout_ms: event.timeoutMs }, "readiness_sweep.timeout");
  } else if (event.type === "collection_started") {
    logger.info("readiness_sweep.collection_started");
  } else if (event.type === "collection_completed") {
    logger.info({ file_count: event.fileCount }, "readiness_sweep.collection_completed");
  }
}

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

function usageFromAssistant(message: AssistantMessage | undefined): HarnessUsage {
  if (!message) return emptyUsage();
  return {
    requests: 1,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cost: message.usage.cost.total
  };
}

function emptyUsage(): HarnessUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}
