import { describe, expect, it } from "vitest";

import { addAssistantUsage, emptyUsage } from "../src/harness/usage.js";

describe("assistant usage aggregation", () => {
  it("sums every observed model turn", () => {
    const first = addAssistantUsage(emptyUsage(), message(10, 5, 15, 0.01));
    const second = addAssistantUsage(first, message(20, 8, 28, 0.02));

    expect(second).toEqual({
      requests: 2,
      inputTokens: 30,
      outputTokens: 13,
      totalTokens: 43,
      completeness: "complete",
      cost: 0.03
    });
  });

  it("marks aggregate usage unknown when any turn is unmeasured", () => {
    const first = addAssistantUsage(emptyUsage(), undefined);
    const second = addAssistantUsage(first, message(4, 2, 6, 0));

    expect(second).toMatchObject({
      requests: 2,
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      completeness: "unknown"
    });
  });
});

function message(input: number, output: number, totalTokens: number, cost: number) {
  return {
    role: "assistant" as const,
    content: [],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
    api: "openai-completions" as const,
    provider: "minimax",
    model: "fake"
  };
}
