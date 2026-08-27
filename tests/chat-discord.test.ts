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

  it("loads Discord bot guardrail config from environment variables", () => {
    const config = loadDiscordBotConfig({
      DISCORD_BOT_TOKEN: "token-value",
      DISCORD_ALLOWED_GUILD_IDS: "guild-1, guild-2",
      DISCORD_ALLOWED_CHANNEL_IDS: "channel-1",
      DISCORD_DEFAULT_REPO_PATH: "/tmp/demo",
      DISCORD_DEFAULT_MODEL: "MiniMax-M3",
      DISCORD_TIMEOUT_MS: "1000",
      DISCORD_ALLOW_DMS: "true"
    });

    expect(config.token).toBe("token-value");
    expect([...config.allowedGuildIds]).toEqual(["guild-1", "guild-2"]);
    expect([...config.allowedChannelIds]).toEqual(["channel-1"]);
    expect(config.defaultRepoPath).toBe("/tmp/demo");
    expect(config.defaultModel).toBe("MiniMax-M3");
    expect(config.defaultTimeoutMs).toBe(1000);
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
