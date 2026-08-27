import { logger } from "../../logger.js";
import { runSweepWorkflow } from "../../workflows/sweep.js";
import { routeChatMessage } from "./router.js";
import type { ChatMessage, ChatResponse, ChatRouterOptions } from "./types.js";

export async function handleChatMessage(
  message: ChatMessage,
  options: ChatRouterOptions = {}
): Promise<ChatResponse> {
  const intent = routeChatMessage(message, options);
  if (intent.kind === "clarify") {
    return { kind: "clarify", text: intent.question };
  }
  if (intent.kind === "unsupported") {
    return { kind: "ignored", text: intent.reason };
  }

  const chatLogger = logger.child({
    surface: "chat",
    chat_platform: message.platform,
    channel_id: message.channelId,
    thread_id: message.threadId,
    message_id: message.messageId,
    user_id: message.userId,
    workflow_name: intent.workflow
  });
  chatLogger.info({ repo_path: intent.repoPath }, "chat.workflow_started");

  const result = await runSweepWorkflow(intent.repoPath, {
    model: intent.model,
    timeoutMs: intent.timeoutMs
  });

  chatLogger.info(
    {
      repo_path: result.repoPath,
      run_id: result.runId,
      status: result.status,
      report_path: result.reportPath,
      token_count: result.usage.totalTokens
    },
    "chat.workflow_completed"
  );

  return {
    kind: "message",
    status: result.status,
    text: renderWorkflowSummary(result),
    result
  };
}

function renderWorkflowSummary(result: Awaited<ReturnType<typeof runSweepWorkflow>>): string {
  const lines = [
    `Readiness sweep ${result.status} for ${result.repoPath}.`,
    `Run: ${result.runId}`,
    `Report: ${result.reportPath}`,
    `Tool calls: ${result.toolCalls.length}`,
    `Tokens: ${result.usage.totalTokens}`
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  return lines.join("\n");
}
