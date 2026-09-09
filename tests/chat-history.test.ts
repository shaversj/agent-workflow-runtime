import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader } from "../src/db/index.js";
import { handleChatMessage } from "../src/surfaces/chat/runner.js";
import type { ChatMessage } from "../src/surfaces/chat/types.js";

beforeEach(() => {
  vi.stubEnv("AGENT_OPS_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-")));
  vi.stubEnv("MINIMAX_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

const message: ChatMessage = {
  platform: "discord",
  applicationId: "bot-1",
  channelId: "channel-1",
  messageId: "message-1",
  userId: "user-1",
  text: "run a readiness sweep"
};

describe("accepted chat history", () => {
  it("keeps different users out of the same conversation group and retains target context", async () => {
    const target = "/repo/test";
    await handleChatMessage({ ...message, text: "hello" }, { defaultRepoPath: target });
    await handleChatMessage(
      { ...message, messageId: "message-2", userId: "user-2", text: "hello" },
      { defaultRepoPath: target }
    );
    const reader = openHistoryReader()!;
    try {
      const records = reader.listInteractions();
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.conversationKey)).size).toBe(2);
      expect(records.every((record) => record.target === target)).toBe(true);
    } finally {
      reader.close();
    }
  });
  it.each(["run a readiness sweep", "hello there"])(
    "records %s without artifacts",
    async (text) => {
      const response = await handleChatMessage({ ...message, text });
      const reader = openHistoryReader()!;
      try {
        expect(reader).toBeDefined();
        const interaction = reader.listInteractions()[0]!;
        expect(interaction).toMatchObject({ status: "completed", target: null, incomplete: false });
        expect(reader.listMessages(interaction.id).map((item) => item.content.text)).toEqual([
          text,
          response.text
        ]);
        expect(reader.listRuns(interaction.id)).toHaveLength(1);
        expect(reader.listArtifacts(interaction.id)).toEqual([]);
      } finally {
        reader?.close();
      }
    }
  );

  it("does not execute or disclose a prior response on a duplicate", async () => {
    await handleChatMessage(message);
    const duplicate = await handleChatMessage(message);
    expect(duplicate).toEqual({ kind: "ignored", text: "" });
    const reader = openHistoryReader()!;
    try {
      expect(reader.listInteractions()).toHaveLength(1);
      expect(reader.listMessages(reader.listInteractions()[0]!.id)).toHaveLength(2);
    } finally {
      reader.close();
    }
  });

  it("a failing response hook cannot overwrite finished execution or append another answer", async () => {
    await handleChatMessage(message, {
      onResponseRecorded: () => {
        throw new Error("receipt callback failed");
      }
    });
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions()[0]!;
      expect(interaction.status).toBe("completed");
      expect(reader.listRuns(interaction.id)[0]?.status).toBe("completed");
      expect(reader.listMessages(interaction.id)).toHaveLength(2);
    } finally {
      reader.close();
    }
  });

  it("links a deterministic sweep preparation failure without requiring a report or workspace", async () => {
    const response = await handleChatMessage(message, {
      defaultRepoPath: path.join(process.env.AGENT_OPS_HOME!, "missing-repository")
    });
    expect(response).toMatchObject({ kind: "message", status: "failed" });
    expect(response.text).not.toContain("undefined");
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions()[0]!;
      const runs = reader.listRuns(interaction.id);
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({
        parentRunId: runs[0]!.id,
        kind: "readiness_sweep",
        status: "failed"
      });
      const calls = reader.listToolCalls(runs[0]!.id);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input.incomplete).toBe(false);
      expect(runs[1]?.triggeringToolCallId).toBe(calls[0]?.id);
      expect(reader.listArtifacts(interaction.id)).toEqual([]);
      expect(reader.listMessages(interaction.id)).toHaveLength(2);
    } finally {
      reader.close();
    }
  });
});
