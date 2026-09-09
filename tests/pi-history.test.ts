import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader } from "../src/db/index.js";
import { beginInteraction, flushPendingInteractionFailures } from "../src/harness/interaction.js";
import { defineRegisteredTool } from "../src/tools/registry.js";
import type { RegisteredToolContext } from "../src/tools/registry.js";
import { runChatAgentWorkflow } from "../src/workflows/chat-agent.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/harness/model.js", () => ({
  createMinimaxHarnessModel: () => ({
    modelProvider: "minimax",
    modelRuntime: "pi-ai",
    name: "MiniMax-M3",
    model: { id: "fake", api: "openai-completions", provider: "minimax", reasoning: false },
    models: { streamSimple: transport }
  })
}));

beforeEach(() => {
  vi.stubEnv("AGENT_OPS_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-")));
  vi.stubEnv("MINIMAX_API_KEY", "fake-transport-only");
  transport.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const message = {
  platform: "discord" as const,
  applicationId: "bot-1",
  channelId: "channel-1",
  messageId: "message-1",
  userId: "user-1",
  text: "please use the test tools"
};

function reply(tool: boolean, knownUsage = true) {
  const response: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: "minimax",
    model: "fake",
    content: tool
      ? [
          {
            type: "toolCall",
            id: `call-${transport.mock.calls.length}`,
            name: "test_work",
            arguments: {}
          }
        ]
      : [
          { type: "thinking", thinking: "PRIVATE REASONING" },
          { type: "text", text: "Canonical answer" }
        ],
    usage: {
      input: 8,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: tool ? "toolUse" : "stop",
    timestamp: Date.now()
  };
  if (!knownUsage) Reflect.deleteProperty(response, "usage");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message: response });
  return stream;
}

function work(execute: (context: RegisteredToolContext) => void) {
  return defineRegisteredTool({
    pluginName: "test",
    name: "work",
    label: "Work",
    description: "Test work",
    parameters: Type.Object({}),
    resultSchema: Type.Object({ ok: Type.Boolean() }),
    execute(_params, context) {
      execute(context);
      return { result: { ok: true }, text: "done" };
    }
  });
}

describe("installed Pi history loop", () => {
  it("keeps router requests and linked child model usage on their own runs", async () => {
    transport.mockImplementation(() => reply(transport.mock.calls.length === 1));
    const tool = work((context) => {
      const child = context.recording!.childRun({ kind: "readiness_sweep" });
      const call = child.modelStart({ provider: "minimax", model: "child-model" });
      child.modelFinish({
        id: call,
        status: "completed",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
      });
      child.finishRun({ status: "completed" });
      child.close();
    });
    expect(await runChatAgentWorkflow(message, { availableTools: [tool] })).toMatchObject({
      status: "completed"
    });
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions()[0]!;
      const [root, child] = reader.listRuns(interaction.id);
      expect(child).toMatchObject({ parentRunId: root!.id, kind: "readiness_sweep" });
      expect(child!.triggeringToolCallId).toBe(reader.listToolCalls(root!.id)[0]?.id);
      expect(reader.listModelCalls(root!.id).map((call) => call.totalTokens)).toEqual([10, 10]);
      expect(reader.listModelCalls(child!.id)).toMatchObject([
        { model: "child-model", totalTokens: 150 }
      ]);
      expect(interaction.incomplete).toBe(false);
    } finally {
      reader.close();
    }
  });

  it("continues after an ordinary tool error and records each real model request", async () => {
    let calls = 0;
    transport.mockImplementation(() =>
      reply(transport.mock.calls.length < 3, transport.mock.calls.length !== 3)
    );
    const tool = work(() => {
      if (++calls === 1) throw new Error("ordinary tool failure");
    });
    const response = await runChatAgentWorkflow(message, { availableTools: [tool] });
    expect(response).toMatchObject({ status: "completed", text: "Canonical answer" });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(calls).toBe(2);
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions()[0]!;
      const root = reader.listRuns(interaction.id)[0]!;
      expect(reader.listModelCalls(root.id)).toMatchObject([
        { ordinal: 1, usageState: "known", totalTokens: 10 },
        { ordinal: 2, usageState: "known", totalTokens: 10 },
        { ordinal: 3, usageState: "unknown", totalTokens: null }
      ]);
      expect(reader.listToolCalls(root.id)).toMatchObject([
        { status: "failed", providerCallId: "call-1" },
        { status: "completed", providerCallId: "call-2" }
      ]);
      expect(reader.listMessages(interaction.id)).toHaveLength(2);
      expect(interaction.metadata.incomplete).toBe(false);
      expect(reader.listToolCalls(root.id)[0]?.error?.reasons).toEqual(["error_details"]);
      expect(JSON.stringify(reader.listMessages(interaction.id))).not.toContain(
        "PRIVATE REASONING"
      );
    } finally {
      reader.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = historyDatabasePath() + suffix;
      if (fs.existsSync(file))
        expect(fs.readFileSync(file).includes(Buffer.from("PRIVATE REASONING"))).toBe(false);
    }
  });

  it("a fatal history error prevents Pi's second request and dispatch, then recovers while the owner lives", async () => {
    const recording = beginInteraction({
      source: "discord",
      kind: "chat_agent",
      applicationId: "bot-1",
      sourceMessageId: "message-1",
      userMessage: message.text
    });
    const db = new Database(historyDatabasePath());
    let calls = 0;
    transport.mockImplementation(() => reply(transport.mock.calls.length < 3));
    const tool = work(() => {
      ++calls;
      db.exec(
        "CREATE TRIGGER fail_result BEFORE UPDATE ON tool_call BEGIN SELECT RAISE(ABORT, 'private-database-error'); END"
      );
      db.exec(
        "CREATE TRIGGER fail_terminal BEFORE UPDATE ON interaction BEGIN SELECT RAISE(ABORT, 'private-database-error'); END"
      );
      throw new Error("ordinary tool failure");
    });
    const reader = openHistoryReader()!;
    try {
      const response = await runChatAgentWorkflow(message, { recording, availableTools: [tool] });
      expect(response).toMatchObject({ status: "failed" });
      expect(response.text).toContain("history_recording_failed");
      expect(response.text).not.toContain("private-database-error");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(calls).toBe(1);
      expect(recording.signal.aborted).toBe(true);
      expect(reader.listMessages(recording.interactionId)).toHaveLength(1);
      expect(reader.getInteraction(recording.interactionId)?.status).toBe("running");
      db.exec("DROP TRIGGER fail_result");
      db.exec("DROP TRIGGER fail_terminal");
      expect(flushPendingInteractionFailures()).toBe(0);
      expect(reader.getInteraction(recording.interactionId)).toMatchObject({
        status: "failed",
        incomplete: true,
        ownerPid: process.pid
      });
      expect(reader.listToolCalls(recording.runId)).toMatchObject([{ status: "failed" }]);
      expect(reader.listModelCalls(recording.runId)).toHaveLength(1);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_result");
      db.exec("DROP TRIGGER IF EXISTS fail_terminal");
      flushPendingInteractionFailures();
      reader.close();
      db.close();
      recording.close();
    }
  });

  it("late model completion cannot overwrite a timeout", async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof reply>) => void;
    transport.mockImplementation(
      () =>
        new Promise<ReturnType<typeof reply>>((done) => {
          resolve = done;
        })
    );
    const pending = runChatAgentWorkflow(message, {
      availableTools: [work(() => undefined)],
      defaultTimeoutMs: 20
    });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: "failed" });
    resolve(reply(false));
    await vi.advanceTimersByTimeAsync(1);
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions()[0]!;
      expect(interaction.status).toBe("failed");
      expect(reader.listMessages(interaction.id)).toHaveLength(2);
      expect(reader.listModelCalls(reader.listRuns(interaction.id)[0]!.id)[0]?.status).not.toBe(
        "completed"
      );
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      reader.close();
    }
  });
});
