import { runChatAgentWorkflow } from "../../workflows/chat-agent.js";
import type { ChatHandlerOptions, ChatMessage, ChatResponse } from "./types.js";

export async function handleChatMessage(
  message: ChatMessage,
  options: ChatHandlerOptions = {}
): Promise<ChatResponse> {
  return runChatAgentWorkflow(message, options);
}
