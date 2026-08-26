import fs from "node:fs";
import path from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Api,
  type Message,
  type Model,
  type MutableModels,
  type Usage
} from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";

import { completeWorkflowRun, createWorkflowRun } from "../db/index.js";
import type {
  HarnessUsage,
  ToolCallRecord,
  WorkflowProgressEvent,
  WorkflowResult
} from "../domain/types.js";
import { logger } from "../logger.js";
import {
  buildReadinessSweepPrompt,
  buildReadinessSynthesisPrompt,
  readinessSweepSkill
} from "../skills/readiness-sweep.js";
import { buildReadinessAgentTools, type ToolContext } from "../tools/index.js";
import { renderReportEnvelope } from "../tools/report.js";

const DEFAULT_HARNESS_PROVIDER = "pi-agent-core";
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_SWEEP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MAX_TOOL_CALLS = 14;

export async function runSweepWorkflow(
  repoPath: string,
  options: {
    model?: string;
    timeoutMs?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    onProgress?: (event: WorkflowProgressEvent) => void;
  } = {}
): Promise<WorkflowResult> {
  const absoluteRepoPath = path.resolve(repoPath);
  if (!fs.existsSync(absoluteRepoPath) || !fs.statSync(absoluteRepoPath).isDirectory()) {
    throw new Error(`Repository path does not exist: ${absoluteRepoPath}`);
  }

  const modelName = options.model ?? DEFAULT_HARNESS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
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

  if (!process.env[MINIMAX_API_KEY_ENV]) {
    const markdown = renderReportEnvelope(
      absoluteRepoPath,
      `## Overall Judgment

The sweep workflow was skipped because \`${MINIMAX_API_KEY_ENV}\` is not set.

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
      summary: "Sweep skipped because MiniMax credentials are not configured.",
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

  const context: ToolContext = {
    repoPath: absoluteRepoPath,
    reportPath,
    calls,
    maxToolCalls
  };
  const models = createModels();
  models.setProvider(minimaxProvider());
  const model = models.getModel("minimax", modelName);
  if (!model) {
    throw new Error(`MiniMax model is not available through pi-ai: ${modelName}`);
  }

  let messages: AgentMessage[] = [];
  let workflowError: string | undefined;
  let turnCount = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: readinessSweepSkill,
      model,
      thinkingLevel: "low",
      tools: buildReadinessAgentTools(context),
      messages
    },
    streamFn: (requestModel, llmContext, streamOptions) =>
      models.streamSimple(requestModel, llmContext, {
        ...streamOptions,
        maxTokens: 2000,
        timeoutMs: Math.min(timeoutMs, 90_000)
      }),
    toolExecution: "sequential",
    shouldStopAfterTurn: () => fs.existsSync(reportPath) || turnCount >= maxTurns
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "agent_start") {
      emitProgress(options.onProgress, {
        type: "model_started",
        provider: "minimax",
        model: modelName
      });
    }
    if (event.type === "turn_start") {
      turnCount += 1;
      emitProgress(options.onProgress, { type: "turn_started", turn: turnCount });
    }
    if (event.type === "tool_execution_start") {
      emitProgress(options.onProgress, { type: "tool_started", name: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      emitProgress(options.onProgress, {
        type: "tool_completed",
        name: event.toolName,
        isError: event.isError
      });
      if (event.toolName === "submit_readiness_report" && !event.isError) {
        emitProgress(options.onProgress, { type: "report_submitted", reportPath });
      }
    }
    if (event.type === "agent_end") {
      messages = event.messages;
    }
  });

  try {
    await withWorkflowTimeout(
      agent.prompt(buildReadinessSweepPrompt(absoluteRepoPath)),
      timeoutMs,
      () => {
        emitProgress(options.onProgress, { type: "timeout", timeoutMs });
        agent.abort();
      }
    );
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
  }

  if (messages.length === 0) {
    messages = agent.state.messages;
  }

  let reportWasWritten = fs.existsSync(reportPath);
  let synthesisOutput: string | undefined;
  if (!reportWasWritten && !workflowError) {
    try {
      emitProgress(options.onProgress, { type: "synthesis_started" });
      synthesisOutput = await synthesizeReport({
        models,
        model,
        repoPath: absoluteRepoPath,
        messages,
        timeoutMs: Math.min(timeoutMs, 60_000)
      });
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, renderReportEnvelope(absoluteRepoPath, synthesisOutput), "utf8");
      reportWasWritten = true;
      emitProgress(options.onProgress, { type: "report_submitted", reportPath });
    } catch (error) {
      workflowError = error instanceof Error ? error.message : String(error);
    }
  }

  const usage = usageFromMessages(messages);
  const finalOutput = synthesisOutput ?? lastAssistantText(messages);
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

async function synthesizeReport(input: {
  models: MutableModels;
  model: Model<Api>;
  repoPath: string;
  messages: AgentMessage[];
  timeoutMs: number;
}): Promise<string> {
  const synthesis = await withWorkflowTimeout(
    input.models.completeSimple(
      input.model,
      {
        systemPrompt: `${readinessSweepSkill}

You are now in final synthesis mode. Tools are unavailable. Write the report directly as Markdown.`,
        messages: [
          ...toLlmMessages(input.messages),
          {
            role: "user",
            content: buildReadinessSynthesisPrompt(input.repoPath),
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
    () => undefined
  );
  const text = assistantText(synthesis);
  if (!text) {
    throw new Error("synthesis_returned_no_text");
  }
  return text;
}

function toLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.filter((message): message is Message => {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
    );
  });
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
  }
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

function usageFromMessages(messages: AgentMessage[]): HarnessUsage {
  const usage = emptyUsage();
  for (const message of messages) {
    if (!isAssistantMessageWithUsage(message)) continue;
    usage.requests += 1;
    usage.inputTokens += message.usage.input;
    usage.outputTokens += message.usage.output;
    usage.totalTokens += message.usage.totalTokens;
    usage.cost = (usage.cost ?? 0) + message.usage.cost.total;
  }
  return usage;
}

function emptyUsage(): HarnessUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function isAssistantMessageWithUsage(
  message: AgentMessage
): message is AgentMessage & { usage: Usage } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant"
  );
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (const message of messages.toReversed()) {
    if (!(typeof message === "object" && message !== null && "role" in message)) continue;
    if (message.role !== "assistant") continue;
    return assistantText(message);
  }
  return "";
}

function assistantText(message: AgentMessage & { role: "assistant" }): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}
