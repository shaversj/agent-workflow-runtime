import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

interface ModelIdentity {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
}

export function modelUsage(input: number = 2, output: number = 2): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

export function assistantMessage(
  model: ModelIdentity,
  options: {
    content: AssistantMessage["content"];
    stopReason?: "stop" | "toolUse" | "error" | "aborted";
    inputTokens?: number;
    outputTokens?: number;
    errorMessage?: string;
  }
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: options.content,
    stopReason: options.stopReason ?? "stop",
    timestamp: Date.now(),
    usage: modelUsage(options.inputTokens, options.outputTokens),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {})
  };
}

export function assistantStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error" || message.stopReason === "aborted")
    stream.push({ type: "error", reason: message.stopReason, error: message });
  else if (message.stopReason === "stop" || message.stopReason === "toolUse")
    stream.push({ type: "done", reason: message.stopReason, message });
  else throw new Error("unsupported_test_stop_reason");
  return stream;
}
