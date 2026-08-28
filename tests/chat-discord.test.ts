import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeDiscordMessage,
  renderDiscordResponse
} from "../src/surfaces/chat/discord/adapter.js";
import {
  createDiscordDuplicateGuard,
  sendDiscordReply,
  shouldAcceptDiscordMessage
} from "../src/surfaces/chat/discord/bot.js";
import { loadDiscordBotConfig } from "../src/surfaces/chat/discord/config.js";
import { handleChatMessage } from "../src/surfaces/chat/runner.js";
import { routeChatMessage } from "../src/surfaces/chat/router.js";

describe("Discord chat surface", () => {
  it("normalizes Discord messages into chat messages", () => {
    const message = normalizeDiscordMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      botUserId: "bot-1",
      content: "<@bot-1> can you check whether this repo is ready for agents?"
    });

    expect(message).toEqual({
      platform: "discord",
      workspaceId: "guild-1",
      channelId: "channel-1",
      threadId: undefined,
      messageId: "message-1",
      userId: "user-1",
      text: "can you check whether this repo is ready for agents?"
    });
  });

  it("routes natural language readiness requests to the sweep workflow", () => {
    const message = normalizeDiscordMessage({
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      content: "Can you check whether this repo is ready for agents?"
    });

    expect(message).toBeDefined();
    const intent = routeChatMessage(message!, { defaultRepoPath: "/tmp/demo" });

    expect(intent).toMatchObject({
      kind: "run_workflow",
      workflow: "readiness_sweep",
      repoPath: "/tmp/demo"
    });
  });

  it("asks for a repository when the request has no repo context", () => {
    const message = normalizeDiscordMessage({
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      content: "run a readiness sweep"
    });

    expect(message).toBeDefined();
    const intent = routeChatMessage(message!);

    expect(intent).toEqual({
      kind: "clarify",
      question: "Which repository should I run the readiness sweep against?",
      sourceText: "run a readiness sweep"
    });
  });

  it("runs the sweep workflow from a Discord-shaped message", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "sweep this repo"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain("Readiness sweep skipped");
      expect(response.text).toContain("missing_minimax_api_key");
      expect(response.text).toContain("Summary:");
      expect(response.text).toContain("Repository evidence was collected");
      expect(response.text).toContain("Full report:");
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("returns the latest report without MiniMax credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const reportPath = writeReport(repoPath, "latest.md", "# Latest Report\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "where is the latest readiness report?"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain(reportPath);
      expect(response.text).not.toContain("Readiness sweep skipped");
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("reads the latest report without MiniMax credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    writeReport(repoPath, "latest.md", "# Latest Report\n\nReady.\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "read the latest readiness report"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain("# Latest Report");
      expect(response.text).toContain("Ready.");
      expect(response.text).not.toContain("Readiness sweep skipped");
    } finally {
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("renders Discord replies within the message size limit", () => {
    const [first, second] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: `${"a".repeat(1999)}\n${"b".repeat(100)}`
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(first?.content.length).toBeLessThanOrEqual(2000);
    expect(second?.content.length).toBeLessThanOrEqual(2000);
    expect(first?.replyToMessageId).toBe("message-1");
  });

  it("attaches the Markdown report to a Discord sweep response", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const reportPath = writeReport(repoPath, "latest.md", "# Latest Report\n");
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          repoPath,
          runId: 1,
          reportPath,
          status: "completed",
          provider: "agent-ops-kit",
          model: "MiniMax-M3",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: []
        }
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(reply?.attachments).toEqual([{ path: fs.realpathSync(reportPath), name: "latest.md" }]);
  });

  it("does not attach reports outside the readiness report directory", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    fs.mkdirSync(path.join(repoPath, ".agent-readiness", "reports"), { recursive: true });
    const outsideReportPath = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    fs.writeFileSync(outsideReportPath, "# Outside\n");
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          repoPath,
          runId: 1,
          reportPath: outsideReportPath,
          status: "completed",
          provider: "agent-ops-kit",
          model: "MiniMax-M3",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: []
        }
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(reply?.attachments).toEqual([]);
  });

  it("does not attach symlinked reports that escape the readiness report directory", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const outsideReportPath = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    fs.writeFileSync(outsideReportPath, "# Outside\n");
    const reportDir = path.join(repoPath, ".agent-readiness", "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const symlinkPath = path.join(reportDir, "link.md");
    fs.symlinkSync(outsideReportPath, symlinkPath);
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          repoPath,
          runId: 1,
          reportPath: symlinkPath,
          status: "completed",
          provider: "agent-ops-kit",
          model: "MiniMax-M3",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: []
        }
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(reply?.attachments).toEqual([]);
  });

  it("does not attach reports when the readiness report directory escapes the repo", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const escapedReportDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-reports-"));
    const reportPath = path.join(escapedReportDir, "latest.md");
    fs.writeFileSync(reportPath, "# Outside\n");
    const readinessDir = path.join(repoPath, ".agent-readiness");
    fs.mkdirSync(readinessDir, { recursive: true });
    fs.symlinkSync(escapedReportDir, path.join(readinessDir, "reports"));
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          repoPath,
          runId: 1,
          reportPath,
          status: "completed",
          provider: "agent-ops-kit",
          model: "MiniMax-M3",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: []
        }
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(reply?.attachments).toEqual([]);
  });

  it("retries Discord replies without attachments when file upload fails", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const reportPath = writeReport(repoPath, "latest.md", "# Latest Report\n");
    const sentReplies: unknown[] = [];
    const message = {
      id: "message-1",
      reply(payload: unknown) {
        sentReplies.push(payload);
        if (sentReplies.length === 1) throw new Error("upload failed");
        return Promise.resolve();
      }
    };

    await sendDiscordReply(message as never, {
      content: "Readiness sweep completed.",
      attachments: [{ path: reportPath, name: "latest.md" }]
    });

    expect(sentReplies).toHaveLength(2);
    expect((sentReplies[0] as { files?: unknown[] }).files).toHaveLength(1);
    expect(sentReplies[1]).toEqual({ content: "Readiness sweep completed." });
  });

  it("loads Discord bot guardrail config from environment variables", () => {
    const config = loadDiscordBotConfig({
      DISCORD_BOT_TOKEN: "token-value",
      DISCORD_ALLOWED_GUILD_IDS: "guild-1, guild-2",
      DISCORD_ALLOWED_CHANNEL_IDS: "channel-1",
      DISCORD_DEFAULT_REPO_PATH: "/tmp/demo",
      DISCORD_DEFAULT_MODEL: "MiniMax-M3",
      DISCORD_TIMEOUT_MS: "1000",
      DISCORD_ENABLED_PLUGIN_SOURCES: "readiness,deploy",
      DISCORD_ALLOW_DMS: "true"
    });

    expect(config.token).toBe("token-value");
    expect([...config.allowedGuildIds]).toEqual(["guild-1", "guild-2"]);
    expect([...config.allowedChannelIds]).toEqual(["channel-1"]);
    expect(config.defaultRepoPath).toBe("/tmp/demo");
    expect(config.defaultModel).toBe("MiniMax-M3");
    expect(config.defaultTimeoutMs).toBe(1000);
    expect([...config.enabledPluginSources]).toEqual(["readiness", "deploy"]);
    expect(config.allowDms).toBe(true);
  });

  it("accepts only allowed Discord messages", () => {
    const config = {
      allowedGuildIds: new Set(["guild-1"]),
      allowedChannelIds: new Set(["channel-1"]),
      allowDms: false
    };

    expect(
      shouldAcceptDiscordMessage(
        {
          isBot: false,
          guildId: "guild-1",
          channelId: "channel-1",
          mentionedUserIds: new Set(["bot-1"]),
          botUserId: "bot-1"
        },
        config
      )
    ).toBe(true);
    expect(
      shouldAcceptDiscordMessage(
        {
          isBot: false,
          guildId: "guild-1",
          channelId: "channel-1",
          mentionedUserIds: new Set(),
          botUserId: "bot-1"
        },
        config
      )
    ).toBe(false);
    expect(
      shouldAcceptDiscordMessage(
        {
          isBot: true,
          guildId: "guild-1",
          channelId: "channel-1",
          mentionedUserIds: new Set(["bot-1"]),
          botUserId: "bot-1"
        },
        config
      )
    ).toBe(false);
  });

  it("deduplicates repeated Discord message IDs", () => {
    const guard = createDiscordDuplicateGuard();

    expect(guard.claim("message-1")).toBe(true);
    expect(guard.claim("message-1")).toBe(false);
    expect(guard.claim("message-2")).toBe(true);
  });
});

function writeReport(repoPath: string, name: string, content: string): string {
  const reportDir = path.join(repoPath, ".agent-readiness", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, name);
  fs.writeFileSync(reportPath, content);
  return reportPath;
}
