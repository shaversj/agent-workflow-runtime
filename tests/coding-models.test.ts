import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InMemoryCredentialStore, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { beginInteraction } from "../src/harness/interaction.js";
import { recordCodingModels } from "../src/harness/coding-runtime.js";
import { openHistoryReader } from "../src/db/index.js";

describe("coding model accounting and limits", () => {
  it.each(["coding_usage_unknown", "coding_token_budget_exhausted"])(
    "preserves %s when a streamed response cannot safely continue",
    async (reason) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-models-"));
      const recording = beginInteraction(
        { source: "cli", kind: "code", userMessage: "Fix" },
        { home }
      );
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false
      });
      runtime.registerNativeProvider({
        ...minimaxProvider(),
        streamSimple(model) {
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            model: model.id,
            provider: model.provider,
            content: [{ type: "text", text: "Done" }],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: reason === "coding_usage_unknown" ? NaN : 8,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 20000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        }
      });
      await runtime.setRuntimeApiKey("minimax", "test-only");
      const stop = vi.fn();
      try {
        recordCodingModels(
          runtime,
          recording,
          { maxModelCalls: 2, maxTokens: 10000 },
          recording.signal,
          stop
        );
        await runtime
          .streamSimple(runtime.getModel("minimax", "MiniMax-M3")!, { messages: [] })
          .result();
        expect(stop).toHaveBeenCalledExactlyOnceWith(new Error(reason));
      } finally {
        recording.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  );

  it("reports token-reserve exhaustion before dispatching a model request", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-models-"));
    const recording = beginInteraction(
      { source: "cli", kind: "code", userMessage: "Fix" },
      { home }
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false
    });
    runtime.registerNativeProvider(minimaxProvider());
    const stop = vi.fn();
    try {
      recordCodingModels(
        runtime,
        recording,
        { maxModelCalls: 2, maxTokens: 8192 },
        recording.signal,
        stop
      );
      const model = runtime.getModel("minimax", "MiniMax-M3")!;
      expect(() => runtime.streamSimple(model, { messages: [] })).toThrow(
        "coding_token_budget_exhausted"
      );
      expect(stop).toHaveBeenCalledExactlyOnceWith(new Error("coding_token_budget_exhausted"));
      const reader = openHistoryReader({ home })!;
      try {
        expect(reader.listModelCalls(recording.runId)).toEqual([]);
      } finally {
        reader.close();
      }
    } finally {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("includes SDK completeSimple/compaction calls and blocks the next request at its budget", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-models-"));
    const recording = beginInteraction(
      { source: "cli", kind: "code", userMessage: "Fix" },
      { home }
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false
    });
    let calls = 0;
    const provider = minimaxProvider();
    runtime.registerNativeProvider({
      ...provider,
      streamSimple(model) {
        ++calls;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          model: model.id,
          provider: model.provider,
          content: [{ type: "text", text: "Done" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 8,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      }
    });
    await runtime.setRuntimeApiKey("minimax", "test-only");
    const stop = vi.fn();
    try {
      recordCodingModels(
        runtime,
        recording,
        { maxModelCalls: 2, maxTokens: 10000 },
        recording.signal,
        stop
      );
      const model = runtime.getModel("minimax", "MiniMax-M3")!;
      await runtime.streamSimple(model, { messages: [] }).result();
      await runtime.completeSimple(model, { messages: [] });
      expect(() => runtime.streamSimple(model, { messages: [] })).toThrow(/budget/);
      expect(stop).toHaveBeenCalledExactlyOnceWith(new Error("coding_model_budget_exhausted"));
      expect(calls).toBe(2);
      const reader = openHistoryReader({ home })!;
      try {
        expect(reader.listModelCalls(recording.runId).map((row) => row.totalTokens)).toEqual([
          10, 10
        ]);
      } finally {
        reader.close();
      }
    } finally {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
