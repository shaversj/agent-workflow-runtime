import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader, openHistoryStore } from "../src/db/index.js";
import { resolveInspectionReportPath } from "../src/db/inspection.js";
import { beginInteraction } from "../src/harness/interaction.js";
import * as interactions from "../src/harness/interaction.js";
import * as adapter from "../src/surfaces/chat/discord/adapter.js";
import { handleDiscordMessage, sendDiscordReply } from "../src/surfaces/chat/discord/bot.js";
import { loadDiscordBotConfig } from "../src/surfaces/chat/discord/config.js";
import { historyArtifactsPath } from "../src/workspaces/storage.js";

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

const config = loadDiscordBotConfig({
  DISCORD_BOT_TOKEN: "fake-no-login",
  DISCORD_ALLOW_DMS: "true"
});
beforeEach(() => {
  vi.stubEnv("AGENT_OPS_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "discord-history-")));
  vi.stubEnv("MINIMAX_API_KEY", "");
  transport.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function inbound() {
  const status = { id: "ack-1", edit: vi.fn(), delete: vi.fn() };
  const reply = vi.fn().mockResolvedValue(status);
  const message = {
    id: "source-1",
    guildId: null,
    channelId: "channel-1",
    content: "run a readiness sweep",
    author: { id: "user-1", bot: false },
    client: { user: { id: "bot-user-1" }, application: { id: "application-1" } },
    mentions: { users: { map: () => [] } },
    channel: { type: 1 },
    reply
  };
  return {
    message,
    reply,
    status,
    handle: () => handleDiscordMessage(message as unknown as Message, config)
  };
}

function answer(text: string) {
  vi.stubEnv("MINIMAX_API_KEY", "fake-transport-only");
  transport.mockImplementation(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        api: "openai-completions",
        model: "fake",
        provider: "minimax",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    });
    return stream;
  });
}

describe("Discord durable delivery", () => {
  it.each(["ambient", "unauthorized", "bot"])(
    "excludes %s before consulting history",
    async (kind) => {
      const accept = vi.spyOn(interactions, "beginInteraction");
      const input = inbound();
      input.message.author.bot = kind === "bot";
      if (kind === "ambient") Object.assign(input.message, { guildId: "guild-1" });
      const policy =
        kind === "unauthorized" ? { ...config, allowedChannelIds: new Set(["other"]) } : config;
      await handleDiscordMessage(input.message as unknown as Message, policy);
      expect(input.reply).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expect(openHistoryReader()).toBeUndefined();
      expect(transport).not.toHaveBeenCalled();
    }
  );

  it("claims before acknowledgment and deduplicates across handlers by application identity", async () => {
    const input = inbound();
    input.reply.mockImplementation(() => {
      const reader = openHistoryReader()!;
      try {
        expect(reader.listInteractions()).toHaveLength(1);
      } finally {
        reader.close();
      }
      return Promise.resolve(input.status);
    });
    await input.handle();
    expect(input.reply).toHaveBeenCalledTimes(2);
    const duplicate = inbound();
    await duplicate.handle();
    expect(duplicate.reply).not.toHaveBeenCalled();
    duplicate.message.client.application.id = "application-2";
    await duplicate.handle();
    expect(duplicate.reply).toHaveBeenCalledTimes(2);
    const reader = openHistoryReader()!;
    try {
      expect(
        reader
          .listInteractions()
          .map((row) => row.applicationId)
          .sort()
      ).toEqual(["application-1", "application-2"]);
      for (const row of reader.listInteractions()) {
        expect(row).toMatchObject({ status: "completed", incomplete: false });
        expect(reader.listMessages(row.id)).toHaveLength(2);
      }
    } finally {
      reader.close();
    }
  });

  it("records the configured default target before acknowledgment", async () => {
    const input = inbound();
    input.reply.mockImplementation(() => {
      const reader = openHistoryReader()!;
      try {
        expect(reader.listInteractions()[0]?.target).toBe("/configured/repo");
      } finally {
        reader.close();
      }
      return Promise.resolve(input.status);
    });
    await handleDiscordMessage(input.message as unknown as Message, {
      ...config,
      defaultRepoPath: "/configured/repo"
    });
    expect(input.reply).toHaveBeenCalled();
    const reader = openHistoryReader()!;
    try {
      expect(reader.listInteractions()[0]?.target).toBe("/configured/repo");
    } finally {
      reader.close();
    }
  });

  it("skips execution after initial acknowledgment rejection", async () => {
    answer("must not run");
    const input = inbound();
    input.reply.mockRejectedValue({ status: 403, code: 50013 });
    await input.handle();
    expect(transport).not.toHaveBeenCalled();
    const reader = openHistoryReader()!;
    try {
      const row = reader.listInteractions()[0]!;
      expect(row).toMatchObject({
        status: "skipped",
        error: { text: "initial_acknowledgment_failed" }
      });
      expect(reader.listRuns(row.id)[0]?.status).toBe("skipped");
      const messages = reader.listMessages(row.id);
      expect(messages).toHaveLength(1);
      expect(reader.listDeliveryAttempts(messages[0]!.id)).toMatchObject([{ status: "failed" }]);
    } finally {
      reader.close();
    }
  });

  it("returns a visible start failure without routing when storage cannot open", async () => {
    answer("must not run");
    const file = path.join(process.env.AGENT_OPS_HOME!, "not-a-directory");
    fs.writeFileSync(file, "blocked");
    vi.stubEnv("AGENT_OPS_HOME", file);
    const input = inbound();
    await input.handle();
    expect(input.reply).toHaveBeenCalledExactlyOnceWith(
      "history_recording_failed: request was not started"
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("persists the canonical answer before sending and keeps execution completed on send failure", async () => {
    answer("canonical answer");
    const input = inbound();
    input.reply.mockImplementation((payload: unknown) => {
      if (typeof payload === "string") return Promise.resolve(input.status);
      const reader = openHistoryReader()!;
      try {
        const row = reader.listInteractions()[0]!;
        expect(row.status).toBe("completed");
        const response = reader.listMessages(row.id)[1]!;
        expect(response.content.text).toBe("canonical answer");
        expect(reader.listDeliveryAttempts(response.id)).toMatchObject([{ status: "pending" }]);
      } finally {
        reader.close();
      }
      throw Object.assign(new Error("forbidden"), { status: 403 });
    });
    await input.handle();
    const reader = openHistoryReader()!;
    try {
      const row = reader.listInteractions()[0]!;
      expect(row.status).toBe("completed");
      expect(reader.listDeliveryAttempts(reader.listMessages(row.id)[1]!.id)).toMatchObject([
        { status: "failed" }
      ]);
    } finally {
      reader.close();
    }
  });

  it("preserves partial multipart delivery and does not retry an ambiguous send", async () => {
    answer("a".repeat(4500));
    const input = inbound();
    input.reply
      .mockResolvedValueOnce(input.status)
      .mockResolvedValueOnce({ id: "part-1" })
      .mockRejectedValueOnce(new Error("connection lost"));
    await input.handle();
    expect(input.reply).toHaveBeenCalledTimes(3);
    const reader = openHistoryReader()!;
    try {
      const row = reader.listInteractions()[0]!;
      const response = reader.listMessages(row.id)[1]!;
      expect(response.content.text).toHaveLength(4500);
      expect(row.status).toBe("completed");
      expect(reader.listDeliveryAttempts(response.id)).toMatchObject([
        { part: 1, attempt: 1, status: "acknowledged", surfaceMessageId: "part-1" },
        { part: 2, attempt: 1, status: "uncertain", surfaceMessageId: null }
      ]);
    } finally {
      reader.close();
    }
  });

  it("retains a generated answer if rendering throws", async () => {
    answer("answer before rendering");
    vi.spyOn(adapter, "renderDiscordResponse").mockImplementation(() => {
      throw new Error("render failure");
    });
    const input = inbound();
    await input.handle();
    expect(input.reply).toHaveBeenCalledTimes(1);
    const reader = openHistoryReader()!;
    try {
      const row = reader.listInteractions()[0]!;
      const response = reader.listMessages(row.id)[1]!;
      expect(row.status).toBe("completed");
      expect(response.content.text).toBe("answer before rendering");
      expect(reader.listDeliveryAttempts(response.id)).toMatchObject([
        { status: "failed", error: { text: "response_render_failed" } }
      ]);
    } finally {
      reader.close();
    }
  });

  it.each(["rejected", "ambiguous", "permission"])(
    "handles %s attachment delivery without blind retries",
    async (failure) => {
      const recording = beginInteraction({ source: "cli", kind: "chat", userMessage: "report" });
      const id = recording.appendMessage({ role: "assistant", content: "report answer" });
      recording.finishInteraction({ status: "completed" });
      fs.mkdirSync(historyArtifactsPath(), { recursive: true });
      const report = path.join(historyArtifactsPath(), "full.md");
      fs.writeFileSync(report, "full report ".repeat(10000));
      const reply = vi
        .fn()
        .mockRejectedValueOnce(
          failure === "rejected"
            ? { status: 413 }
            : failure === "permission"
              ? { status: 403 }
              : new Error("network")
        )
        .mockResolvedValueOnce({ id: "fallback-1" });
      try {
        const sent = sendDiscordReply(
          { id: "source", reply },
          { content: "report answer", attachments: [{ path: report, name: "full.md" }] },
          { recording, messageId: id, part: 1 }
        );
        if (failure === "rejected") await expect(sent).resolves.toMatchObject({ id: "fallback-1" });
        else await expect(sent).rejects.toBeDefined();
        expect(reply).toHaveBeenCalledTimes(failure === "rejected" ? 2 : 1);
        const reader = openHistoryReader()!;
        try {
          const attempts = reader.listDeliveryAttempts(id);
          expect(attempts[0]?.status).toBe(failure === "ambiguous" ? "uncertain" : "failed");
          if (failure === "rejected") {
            expect(attempts[0]?.error?.text).toContain("attachment_omitted");
            expect(attempts[1]).toMatchObject({
              attempt: 2,
              status: "acknowledged",
              surfaceMessageId: "fallback-1"
            });
          }
        } finally {
          reader.close();
        }
      } finally {
        recording.close();
      }
    }
  );
});

describe("Discord registered artifacts", () => {
  function reportResponse(input: {
    interactionId: string;
    runId: number;
    reportPath?: string;
    target?: string;
  }) {
    return {
      kind: "message" as const,
      status: "completed" as const,
      text: "Report answer",
      result: {
        interactionId: input.interactionId,
        runId: input.runId,
        status: "completed" as const,
        target: { source: "local-git" as const, origin: input.target ?? "/missing/repo" },
        provider: "agent-ops-kit",
        model: "fake",
        usage: { requests: 0 },
        toolCalls: [],
        reportPath: input.reportPath
      }
    };
  }
  const destination = { channelId: "channel-1", messageId: "source-1" };
  const safeError = "Report attachment is missing, unsafe, or not registered for this workflow.";

  function reportFixture(target = "/missing/repo", type = "markdown", name = "large.md") {
    const store = openHistoryStore();
    try {
      const accepted = store.acceptInteraction({
        source: "cli",
        kind: "chat",
        userMessage: "report"
      });
      const runId = store.createRun({
        interactionId: accepted.interactionId,
        parentRunId: accepted.runId,
        kind: "readiness_sweep",
        target
      });
      const reportPath = path.join(fs.realpathSync(historyArtifactsPath()), name);
      fs.writeFileSync(reportPath, "full report ".repeat(10000));
      store.registerArtifact({
        interactionId: accepted.interactionId,
        runId,
        path: reportPath,
        type
      });
      store.finishRun({ id: runId, status: "completed" });
      store.finishRun({ id: accepted.runId, status: "completed" });
      store.finishInteraction({ id: accepted.interactionId, status: "completed" });
      return { interactionId: accepted.interactionId, runId, reportPath, target };
    } finally {
      store.close();
    }
  }

  it("rejects an unregistered report under the history artifact root", () => {
    const fixture = reportFixture();
    const report = path.join(historyArtifactsPath(), "unregistered.md");
    fs.writeFileSync(report, "must not attach");
    expect(() =>
      adapter.renderDiscordResponse(reportResponse({ ...fixture, reportPath: report }), destination)
    ).toThrow(safeError);
  });

  it("rejects a report when the registry is absent without creating history", () => {
    fs.mkdirSync(historyArtifactsPath(), { recursive: true });
    const reportPath = path.join(historyArtifactsPath(), "unregistered.md");
    fs.writeFileSync(reportPath, "must not attach");
    const response = reportResponse({ reportPath, interactionId: crypto.randomUUID(), runId: 1 });
    expect(() => adapter.renderDiscordResponse(response, destination)).toThrow(safeError);
    expect(openHistoryReader()).toBeUndefined();
  });

  it("persists response_render_failed and the canonical answer when report validation fails", async () => {
    const fixture = reportFixture();
    const reportPath = path.join(historyArtifactsPath(), "unregistered.md");
    fs.writeFileSync(reportPath, "must not attach");
    const render = adapter.renderDiscordResponse;
    vi.spyOn(adapter, "renderDiscordResponse").mockImplementation((response, destination) =>
      render({ ...reportResponse({ ...fixture, reportPath }), text: response.text }, destination)
    );
    answer("canonical answer before report validation");
    const input = inbound();
    await input.handle();
    expect(input.reply).toHaveBeenCalledTimes(1);
    const reader = openHistoryReader()!;
    try {
      const interaction = reader.listInteractions().find((row) => row.source === "discord")!;
      expect(interaction.status).toBe("completed");
      const response = reader.listMessages(interaction.id)[1]!;
      expect(response.content.text).toBe("canonical answer before report validation");
      expect(reader.listDeliveryAttempts(response.id)).toMatchObject([
        { status: "failed", error: { text: "response_render_failed" } }
      ]);
    } finally {
      reader.close();
    }
  });

  it("attaches the complete shared report without a repoPath or workspace", () => {
    const fixture = reportFixture();
    const rendered = adapter.renderDiscordResponse(reportResponse(fixture), destination);
    expect(rendered[0]?.attachments).toEqual([{ path: fixture.reportPath, name: "large.md" }]);
    expect(fs.statSync(rendered[0]!.attachments![0]!.path).size).toBeGreaterThan(65536);
    expect(
      adapter.renderDiscordResponse(
        reportResponse({ ...fixture, reportPath: undefined }),
        destination
      )[0]?.attachments
    ).toEqual([]);
    expect(resolveInspectionReportPath({ reportPath: fixture.reportPath })).toBe(
      fixture.reportPath
    );
  });

  it.each(["same-target", "other-target"])(
    "rejects a registered report from another run on %s",
    (kind) => {
      const own = reportFixture();
      const other = reportFixture(
        kind === "same-target" ? own.target : "/other/repo",
        "markdown",
        "other.md"
      );
      const response = reportResponse({ ...own, reportPath: other.reportPath });
      expect(() => adapter.renderDiscordResponse(response, destination)).toThrow(safeError);
    }
  );

  it("requires the run ID even when the registered report belongs to the same interaction", () => {
    const fixture = reportFixture();
    const reader = openHistoryReader()!;
    try {
      const rootRun = reader.listRuns(fixture.interactionId)[0]!;
      expect(rootRun.id).not.toBe(fixture.runId);
      const response = reportResponse({ ...fixture, runId: rootRun.id });
      expect(() => adapter.renderDiscordResponse(response, destination)).toThrow(safeError);
    } finally {
      reader.close();
    }
  });

  it("requires the interaction ID and target even when the run and path match", () => {
    const fixture = reportFixture();
    for (const input of [
      { ...fixture, interactionId: crypto.randomUUID() },
      { ...fixture, target: "/other/repo" }
    ])
      expect(() => adapter.renderDiscordResponse(reportResponse(input), destination)).toThrow(
        safeError
      );
  });

  it.each(["runId", "interactionId", "target"])(
    "rejects an attachment with missing %s",
    (field) => {
      const response = reportResponse(reportFixture());
      Reflect.deleteProperty(response.result, field);
      expect(() => adapter.renderDiscordResponse(response, destination)).toThrow(safeError);
    }
  );

  it.each(["artifact-type", "extension", "empty-path"])(
    "rejects %s even with matching workflow ownership",
    (kind) => {
      const fixture = reportFixture(
        "/missing/repo",
        kind === "artifact-type" ? "binary" : "markdown",
        kind === "extension" ? "report.txt" : "large.md"
      );
      const response = reportResponse({
        ...fixture,
        reportPath: kind === "empty-path" ? "" : fixture.reportPath
      });
      expect(() => adapter.renderDiscordResponse(response, destination)).toThrow(safeError);
    }
  );

  it.each([
    "outside",
    "traversal",
    "missing",
    "directory",
    "file-symlink",
    "root-symlink",
    "history-symlink"
  ])("rejects %s reports without substituting a valid artifact", (kind) => {
    const fixture = reportFixture();
    const root = fs.realpathSync(historyArtifactsPath());
    const outside = path.join(process.env.AGENT_OPS_HOME!, "private.md");
    fs.writeFileSync(outside, "must not attach");
    let reportPath = fixture.reportPath;
    if (kind === "outside") reportPath = outside;
    else if (kind === "traversal") reportPath = "../../private.md";
    else if (kind === "root-symlink" || kind === "history-symlink") {
      const original = kind === "root-symlink" ? root : path.dirname(root);
      const relocated = path.join(process.env.AGENT_OPS_HOME!, "relocated");
      fs.renameSync(original, relocated);
      fs.symlinkSync(relocated, original);
    } else {
      fs.unlinkSync(reportPath);
      if (kind === "file-symlink") fs.symlinkSync(outside, reportPath);
      else if (kind === "directory") fs.mkdirSync(reportPath);
    }
    expect(() =>
      adapter.renderDiscordResponse(reportResponse({ ...fixture, reportPath }), destination)
    ).toThrow(safeError);
  });
});
