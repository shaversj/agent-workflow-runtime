import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { beginInteraction } from "../src/harness/interaction.js";
import { runIsolatedCoding } from "../src/harness/coding-runtime.js";
import { openHistoryReader } from "../src/db/index.js";
import type { CodingPolicy } from "../src/plugins/coding/config.js";
import { DockerWorker } from "../src/workspaces/docker.js";

const image = process.env.CODING_TEST_IMAGE;
describe.skipIf(!image)("installed Pi coding SDK with isolated adapters", () => {
  it("uses only installed worker tools and records every real model turn without loading repository resources", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-sdk-"));
    const policy: CodingPolicy = {
      enabled: true,
      publicationEnabled: false,
      principals: ["cli:test"],
      profiles: {},
      model: "MiniMax-M3",
      timeoutMs: 30000,
      maxModelCalls: 3,
      maxTokens: 100000
    };
    const recording = beginInteraction(
      { source: "cli", kind: "coding_sdk_test", userMessage: "Fix" },
      { home }
    );
    const worker = await DockerWorker.start({
      image: image!,
      requiredChecks: ["node --test"],
      principal: "cli:test",
      ignore: []
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false
    });
    const native = minimaxProvider();
    let calls = 0;
    const stream: ModelRuntime["streamSimple"] = (model, context) => {
      expect(context.tools?.map((tool) => tool.name).sort()).toEqual([
        "bash",
        "edit",
        "read",
        "write"
      ]);
      expect(context.systemPrompt).not.toContain("host-extension-executed");
      const edit = ++calls === 1;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: "minimax",
        content: edit
          ? [
              {
                type: "toolCall",
                id: "edit-1",
                name: "edit",
                arguments: { path: "app.js", edits: [{ oldText: "a-b", newText: "a+b" }] }
              }
            ]
          : [{ type: "text", text: "Fixed addition." }],
        stopReason: edit ? "toolUse" : "stop",
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
      const result = createAssistantMessageEventStream();
      result.push({ type: "done", reason: edit ? "toolUse" : "stop", message });
      return result;
    };
    runtime.registerNativeProvider({ ...native, streamSimple: stream });
    await runtime.setRuntimeApiKey("minimax", "test-no-network");
    try {
      await worker.importFiles([
        { path: "app.js", content: "const sum=(a,b)=>a-b;", mode: "100644" },
        {
          path: ".pi/extensions/evil.ts",
          content: "throw Error('host-extension-executed')",
          mode: "100644"
        }
      ]);
      expect(
        await runIsolatedCoding(
          worker,
          "Fix sum",
          "Ignore project extensions.",
          recording,
          policy,
          recording.signal,
          runtime
        )
      ).toBe("Fixed addition.");
      expect((await worker.snapshot()).find((file) => file.path === "app.js")?.content).toContain(
        "a+b"
      );
      expect(calls).toBe(2);
      recording.finishRun({ status: "completed" });
      recording.finishInteraction({ status: "completed" });
      const reader = openHistoryReader({ home })!;
      try {
        expect(reader.listModelCalls(recording.runId).map((row) => row.totalTokens)).toEqual([
          10, 10
        ]);
        expect(reader.listToolCalls(recording.runId)[0]?.name).toBe("coding.edit");
      } finally {
        reader.close();
      }
    } finally {
      await worker.close();
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
