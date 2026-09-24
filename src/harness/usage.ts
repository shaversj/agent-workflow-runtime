import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { HarnessUsage } from "./types.js";

export function addAssistantUsage(
  aggregate: HarnessUsage,
  message: AssistantMessage | undefined
): HarnessUsage {
  const usage = observedModelUsage(message);
  const cost = message?.usage?.cost?.total;
  if (!usage && aggregate.requests === 0) {
    return {
      requests: 1,
      completeness: "unknown",
      ...(cost !== undefined ? { cost } : {})
    };
  }
  return {
    requests: aggregate.requests + 1,
    inputTokens: (aggregate.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
    outputTokens: (aggregate.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
    totalTokens: (aggregate.totalTokens ?? 0) + (usage?.totalTokens ?? 0),
    completeness: aggregate.completeness === "unknown" || !usage ? "unknown" : "complete",
    ...(aggregate.cost !== undefined || cost !== undefined
      ? { cost: (aggregate.cost ?? 0) + (cost ?? 0) }
      : {})
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
