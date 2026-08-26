import fs from "node:fs";
import path from "node:path";

import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type Usage } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";

import { completeWorkflowRun, createWorkflowRun } from "../db/index.js";
import type { HarnessUsage, ToolCallRecord, WorkflowResult } from "../domain/types.js";
import { logger } from "../logger.js";
import { buildReadinessSweepPrompt, readinessSweepSkill } from "../skills/readiness-sweep.js";
import { buildReadinessAgentTools, type ToolContext } from "../tools/index.js";
import { renderReportEnvelope } from "../tools/report.js";

const DEFAULT_HARNESS_PROVIDER = "pi-agent-core";
export const DEFAULT_HARNESS_MODEL = "MiniMax-M3";
const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";

export async function runSweepWorkflow(
  repoPath: string,
  options: { model?: string } = {}
): Promise<WorkflowResult> {
  const absoluteRepoPath = path.resolve(repoPath);
  if (!fs.existsSync(absoluteRepoPath) || !fs.statSync(absoluteRepoPath).isDirectory()) {
    throw new Error(`Repository path does not exist: ${absoluteRepoPath}`);
  }

  const modelName = options.model ?? DEFAULT_HARNESS_MODEL;
  const runStore = createWorkflowRun(absoluteRepoPath, DEFAULT_HARNESS_PROVIDER, modelName);
  runStore.sqlite.close();

  const reportPath = reportPathFor(absoluteRepoPath, runStore.run.id);
  const calls: ToolCallRecord[] = [];

  logger.info({ repo_path: absoluteRepoPath, run_id: runStore.run.id }, "readiness_sweep.started");

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
    calls
  };
  const models = createModels();
  models.setProvider(minimaxProvider());
  const model = models.getModel("minimax", modelName);
  if (!model) {
    throw new Error(`MiniMax model is not available through pi-ai: ${modelName}`);
  }

  const messages: AgentMessage[] = [];
  let workflowError: string | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: readinessSweepSkill,
      model,
      thinkingLevel: "low",
      tools: buildReadinessAgentTools(context),
      messages
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: "sequential"
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "agent_end") {
      messages.push(...event.messages);
    }
  });

  try {
    await agent.prompt(buildReadinessSweepPrompt(absoluteRepoPath));
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
  }

  const usage = usageFromMessages(messages);
  const finalOutput = lastAssistantText(messages);
  const reportWasWritten = fs.existsSync(reportPath);
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
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
  }
  return "";
}
