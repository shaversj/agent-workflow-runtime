import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { HarnessUsage } from "./types.js";

export function usageFromAssistant(message: AssistantMessage | undefined): HarnessUsage {
  if (!message) return emptyUsage();
  return {
    requests: 1,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    totalTokens: message.usage.totalTokens,
    cost: message.usage.cost.total
  };
}

export function emptyUsage(): HarnessUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}
