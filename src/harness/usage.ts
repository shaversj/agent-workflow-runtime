import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { HarnessUsage } from "./types.js";

export function usageFromAssistant(message: AssistantMessage | undefined): HarnessUsage {
  if (!message) return emptyUsage();
  const usage = observedModelUsage(message);
  return {
    requests: 1,
    ...usage,
    completeness: usage ? "complete" : "unknown",
    ...(message.usage?.cost?.total !== undefined ? { cost: message.usage.cost.total } : {})
  };
}

export function observedModelUsage(message: AssistantMessage | undefined) {
  const usage = message?.usage;
  if (
    !usage ||
    !Number.isInteger(usage.input) ||
    usage.input < 0 ||
    !Number.isInteger(usage.output) ||
    usage.output < 0
  )
    return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens:
      Number.isInteger(usage.totalTokens) && usage.totalTokens >= 0
        ? usage.totalTokens
        : usage.input + usage.output
  };
}

export function emptyUsage(): HarnessUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    completeness: "complete"
  };
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}
