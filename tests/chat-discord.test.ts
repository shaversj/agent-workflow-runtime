import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import { displayInspectionTarget } from "../src/db/inspection.js";
import {
  normalizeDiscordMessage,
  renderDiscordResponse
} from "../src/surfaces/chat/discord/adapter.js";
import {
  createDiscordClient,
  sendDiscordReply,
  shouldAcceptDiscordMessage
} from "../src/surfaces/chat/discord/bot.js";
import { loadDiscordBotConfig } from "../src/surfaces/chat/discord/config.js";
import { handleChatMessage } from "../src/surfaces/chat/runner.js";
import { routeChatMessage } from "../src/surfaces/chat/router.js";
import { repoTargetForChatMessage } from "../src/workflows/chat-agent.js";
import { runSweepWorkflow } from "../src/workflows/sweep.js";
import { historyArtifactsPath } from "../src/workspaces/storage.js";

beforeEach(() => {
  vi.stubEnv("AGENT_OPS_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "chat-discord-history-")));
  vi.stubEnv("MINIMAX_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("Discord chat surface", () => {
  it("disables SDK retries so uncertain sends cannot bypass delivery tracking", async () => {
    const client = createDiscordClient(
      loadDiscordBotConfig({
        DISCORD_BOT_TOKEN: "test",
        DISCORD_ALLOWED_USER_IDS: "10000000000000001",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001"
      })
    );
    try {
      expect(client.rest.options.retries).toBe(0);
    } finally {
      await client.destroy();
      await client.rest.agent?.destroy();
    }
  });

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
      applicationId: "bot-1",
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
      applicationId: "application-1",
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

  it("routes explicit Git URL sweep requests instead of the configured default repo", () => {
    const message = normalizeDiscordMessage({
      applicationId: "application-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      content: "sweep https://github.com/example/example-repository"
    });

    expect(message).toBeDefined();
    const intent = routeChatMessage(message!, { defaultRepoPath: "/tmp/default" });

    expect(intent).toMatchObject({
      kind: "run_workflow",
      workflow: "readiness_sweep",
      repoPath: "https://github.com/example/example-repository"
    });
    expect(repoTargetForChatMessage(message!, { defaultRepoPath: "/tmp/default" }, intent)).toBe(
      "https://github.com/example/example-repository"
    );
  });

  it("asks for a repository when the request has no repo context", () => {
    const message = normalizeDiscordMessage({
      applicationId: "application-1",
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
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "sweep this repo",
        applicationId: "application-1"
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
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("inspects repository rules without model credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const repoPath = gitRepo();
    fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "# Agent rules\nUse pnpm.\n");
    git(["add", "AGENTS.md"], repoPath);
    git(["commit", "-m", "Add agent rules"], repoPath);

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-rules",
        authorId: "user-1",
        content: "rules inventory",
        applicationId: "application-1"
      });

      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain("Repository rules");
      expect(response.text).toContain("AGENTS.md");
      expect(response.text).toContain("committed snapshot");
    } finally {
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("returns the latest report without MiniMax credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const { reportPath } = writeReport(repoPath, "latest.md", "# Latest Report\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "where is the latest readiness report?",
        applicationId: "application-1"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain(reportPath);
      expect(response.text).not.toContain("Readiness sweep skipped");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("accepts command-shaped latest report requests", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const { reportPath } = writeReport(repoPath, "latest.md", "# Latest Report\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "reports latest",
        applicationId: "application-1"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain(reportPath);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("reads the latest report without MiniMax credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    writeReport(repoPath, "latest.md", "# Latest Report\n\nReady.\n");

    try {
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "read the latest readiness report",
        applicationId: "application-1"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain("# Latest Report");
      expect(response.text).toContain("Ready.");
      expect(response.text).not.toContain("Readiness sweep skipped");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("returns run lists without MiniMax credentials", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();

    try {
      await runSweepWorkflow(repoPath);
      const message = normalizeDiscordMessage({
        channelId: "channel-1",
        messageId: "message-1",
        authorId: "user-1",
        content: "runs list",
        applicationId: "application-1"
      });

      expect(message).toBeDefined();
      const response = await handleChatMessage(message!, { defaultRepoPath: repoPath });

      expect(response.kind).toBe("message");
      expect(response.text).toContain("status=skipped");
      expect(response.text).toContain("tokens=unknown");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("asks for repo context before Discord run list inspection", async () => {
    const message = normalizeDiscordMessage({
      applicationId: "application-1",
      channelId: "channel-1",
      messageId: "message-1",
      authorId: "user-1",
      content: "runs list"
    });

    expect(message).toBeDefined();
    const response = await handleChatMessage(message!);

    expect(response).toEqual({
      kind: "clarify",
      text: "Which repository should I use to list readiness runs?"
    });
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
    const { reportPath, runId, interactionId } = writeReport(
      repoPath,
      "latest.md",
      "# Latest Report\n"
    );
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          target: localTarget(repoPath),
          repoPath,
          runId,
          interactionId,
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

  it("attaches managed Markdown reports for workspace-backed sweep responses", () => {
    const { reportPath, runId, interactionId } = writeReport(
      "https://github.com/example/demo",
      "latest.md",
      "# Latest Report\n"
    );
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-workspace-"));
    const [reply] = renderDiscordResponse(
      {
        kind: "message",
        status: "completed",
        text: "Readiness sweep completed.",
        result: {
          target: gitUrlTarget("https://github.com/example/demo"),
          repoPath: workspacePath,
          runId,
          interactionId,
          reportPath,
          status: "completed",
          provider: "agent-ops-kit",
          model: "MiniMax-M3",
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: [],
          workspace: {
            id: "lease-1",
            source: "git-url",
            origin: "https://github.com/example/demo",
            displayOrigin: "https://github.com/example/demo",
            ref: "main",
            commitSha: "a".repeat(40),
            path: workspacePath,
            cleanupPolicy: "delete"
          }
        }
      },
      {
        channelId: "channel-1",
        messageId: "message-1"
      }
    );

    expect(reply?.attachments).toEqual([{ path: fs.realpathSync(reportPath), name: "latest.md" }]);
  });

  it("fails rendering for reports outside the history artifact directory", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const { runId, interactionId } = writeReport(repoPath, "registered.md", "# Registered\n");
    const outsideReportPath = path.join(repoPath, "outside.md");
    fs.writeFileSync(outsideReportPath, "# Outside\n");
    const render = () =>
      renderDiscordResponse(
        {
          kind: "message",
          status: "completed",
          text: "Readiness sweep completed.",
          result: {
            target: localTarget(repoPath),
            repoPath,
            runId,
            interactionId,
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

    expect(render).toThrow(
      "Report attachment is missing, unsafe, or not registered for this workflow."
    );
  });

  it("fails rendering when a registered report is replaced by a symlink", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const outsideReportPath = path.join(repoPath, "outside.md");
    fs.writeFileSync(outsideReportPath, "# Outside\n");
    const {
      reportPath: symlinkPath,
      runId,
      interactionId
    } = writeReport(repoPath, "link.md", "# Registered\n");
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(outsideReportPath, symlinkPath);
    const render = () =>
      renderDiscordResponse(
        {
          kind: "message",
          status: "completed",
          text: "Readiness sweep completed.",
          result: {
            target: localTarget(repoPath),
            repoPath,
            runId,
            interactionId,
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

    expect(render).toThrow(
      "Report attachment is missing, unsafe, or not registered for this workflow."
    );
  });

  it("fails rendering when the registered artifact root becomes a symlink", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const { reportPath, runId, interactionId } = writeReport(
      repoPath,
      "latest.md",
      "# Registered\n"
    );
    const escapedReportDir = path.join(repoPath, "reports");
    fs.renameSync(historyArtifactsPath(), escapedReportDir);
    fs.symlinkSync(escapedReportDir, historyArtifactsPath());
    const render = () =>
      renderDiscordResponse(
        {
          kind: "message",
          status: "completed",
          text: "Readiness sweep completed.",
          result: {
            target: localTarget(repoPath),
            repoPath,
            runId,
            interactionId,
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

    expect(render).toThrow(
      "Report attachment is missing, unsafe, or not registered for this workflow."
    );
  });

  it("projects hostile Discord reply failures without inspecting them", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
    const { reportPath } = writeReport(repoPath, "latest.md", "# Latest Report\n");
    const sentReplies: unknown[] = [];
    const hostile = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("hostile getter was inspected");
      },
      getOwnPropertyDescriptor() {
        throw new Error("hostile descriptor was inspected");
      },
      getPrototypeOf() {
        throw new Error("hostile prototype was inspected");
      },
      ownKeys() {
        throw new Error("hostile keys were inspected");
      }
    });
    const message = {
      id: "message-1",
      reply(payload: unknown) {
        sentReplies.push(payload);
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- verifies hostile non-Error values stay opaque
        throw hostile;
      }
    };

    await expect(
      sendDiscordReply(message as never, {
        content: "Readiness sweep completed.",
        attachments: [{ path: reportPath, name: "latest.md" }]
      })
    ).rejects.toThrow(/^The request could not be completed\. Reference: [0-9a-f-]+\.$/);

    expect(sentReplies).toHaveLength(1);
    expect((sentReplies[0] as { files?: unknown[] }).files).toHaveLength(1);
  });

  it("loads Discord bot guardrail config from environment variables", () => {
    const config = loadDiscordBotConfig({
      DISCORD_BOT_TOKEN: "token-value",
      DISCORD_ALLOWED_USER_IDS: "10000000000000001,10000000000000002",
      DISCORD_ALLOWED_GUILD_IDS: "20000000000000001,20000000000000002",
      DISCORD_ALLOWED_CHANNEL_IDS: "30000000000000001",
      DISCORD_LOCAL_REPO_USER_IDS: "10000000000000001",
      DISCORD_DEFAULT_REPO_PATH: "/tmp/demo",
      DISCORD_DEFAULT_MODEL: "MiniMax-M3",
      DISCORD_TIMEOUT_MS: "1000",
      DISCORD_SHUTDOWN_GRACE_MS: "5000",
      DISCORD_ENABLED_PLUGIN_SOURCES: "readiness,deploy"
    });

    expect(config.token).toBe("token-value");
    expect([...config.allowedUserIds]).toEqual(["10000000000000001", "10000000000000002"]);
    expect([...config.allowedGuildIds]).toEqual(["20000000000000001", "20000000000000002"]);
    expect([...config.allowedChannelIds]).toEqual(["30000000000000001"]);
    expect([...config.localRepoUserIds]).toEqual(["10000000000000001"]);
    expect(config.defaultRepoPath).toBe("/tmp/demo");
    expect(config.defaultModel).toBe("MiniMax-M3");
    expect(config.defaultTimeoutMs).toBe(1000);
    expect(config.shutdownGraceMs).toBe(5000);
    expect([...config.enabledPluginSources]).toEqual(["readiness", "deploy"]);
    expect(config.allowDms).toBe(false);
  });

  it("enables readiness, GitHub, and rules plugin sources by default", () => {
    const config = loadDiscordBotConfig({
      DISCORD_BOT_TOKEN: "token-value",
      DISCORD_ALLOWED_USER_IDS: "10000000000000001",
      DISCORD_ALLOWED_CHANNEL_IDS: "30000000000000001"
    });

    expect([...config.enabledPluginSources]).toEqual(["readiness", "github", "rules"]);
  });

  it.each([
    ["missing users", { DISCORD_ALLOWED_GUILD_IDS: "20000000000000001" }],
    ["missing guild and channel", { DISCORD_ALLOWED_USER_IDS: "10000000000000001" }],
    [
      "malformed user IDs",
      {
        DISCORD_ALLOWED_USER_IDS: "not-a-discord-id",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001"
      }
    ],
    [
      "direct messages",
      {
        DISCORD_ALLOWED_USER_IDS: "10000000000000001",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001",
        DISCORD_ALLOW_DMS: "true"
      }
    ],
    [
      "an invalid shutdown grace",
      {
        DISCORD_ALLOWED_USER_IDS: "10000000000000001",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001",
        DISCORD_SHUTDOWN_GRACE_MS: "0"
      }
    ],
    [
      "local defaults without a local-path capability",
      {
        DISCORD_ALLOWED_USER_IDS: "10000000000000001",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001",
        DISCORD_DEFAULT_REPO_PATH: "/tmp/demo"
      }
    ],
    [
      "local-path capability outside the user allowlist",
      {
        DISCORD_ALLOWED_USER_IDS: "10000000000000001",
        DISCORD_ALLOWED_GUILD_IDS: "20000000000000001",
        DISCORD_LOCAL_REPO_USER_IDS: "10000000000000002"
      }
    ]
  ])("rejects %s before Discord startup", (_name, policy) => {
    expect(() => loadDiscordBotConfig({ DISCORD_BOT_TOKEN: "token-value", ...policy })).toThrow();
  });

  it("accepts guild-only and channel-only restrictions", () => {
    const shared = {
      DISCORD_BOT_TOKEN: "token-value",
      DISCORD_ALLOWED_USER_IDS: "10000000000000001"
    };
    expect(
      loadDiscordBotConfig({ ...shared, DISCORD_ALLOWED_GUILD_IDS: "20000000000000001" })
        .allowedGuildIds
    ).toEqual(new Set(["20000000000000001"]));
    expect(
      loadDiscordBotConfig({ ...shared, DISCORD_ALLOWED_CHANNEL_IDS: "30000000000000001" })
        .allowedChannelIds
    ).toEqual(new Set(["30000000000000001"]));
  });

  it("accepts only allowed Discord messages", () => {
    const config = {
      allowedUserIds: new Set(["user-1"]),
      allowedGuildIds: new Set(["guild-1"]),
      allowedChannelIds: new Set(["channel-1"])
    };

    expect(
      shouldAcceptDiscordMessage(
        {
          isBot: false,
          isWebhook: false,
          authorId: "user-1",
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
          isWebhook: false,
          authorId: "user-1",
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
          isWebhook: false,
          authorId: "user-1",
          guildId: "guild-1",
          channelId: "channel-1",
          mentionedUserIds: new Set(["bot-1"]),
          botUserId: "bot-1"
        },
        config
      )
    ).toBe(false);
    for (const denied of [
      { authorId: "user-2" },
      { guildId: "guild-2" },
      { channelId: "channel-2" },
      { guildId: undefined },
      { isWebhook: true }
    ]) {
      expect(
        shouldAcceptDiscordMessage(
          {
            isBot: false,
            isWebhook: false,
            authorId: "user-1",
            guildId: "guild-1",
            channelId: "channel-1",
            mentionedUserIds: new Set(["bot-1"]),
            botUserId: "bot-1",
            ...denied
          },
          config
        )
      ).toBe(false);
    }
  });
});

function writeReport(target: string, name: string, content: string) {
  const store = openHistoryStore();
  try {
    const { runId, interactionId } = store.acceptInteraction({
      source: "cli",
      kind: "readiness_sweep",
      target: displayInspectionTarget(target),
      userMessage: "report fixture"
    });
    const reportPath = path.join(fs.realpathSync(historyArtifactsPath()), name);
    fs.writeFileSync(reportPath, content);
    store.registerArtifact({ interactionId, runId, path: reportPath, type: "markdown" });
    store.finishRun({ id: runId, status: "completed" });
    store.finishInteraction({ id: interactionId, status: "completed" });
    return { reportPath, runId, interactionId };
  } finally {
    store.close();
  }
}

function localTarget(repoPath: string) {
  return {
    source: "local-git" as const,
    origin: repoPath,
    ref: "HEAD",
    commitSha: "a".repeat(40)
  };
}

function gitUrlTarget(origin: string) {
  return {
    source: "git-url" as const,
    origin,
    ref: "main",
    commitSha: "a".repeat(40)
  };
}

function gitRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
  git(["init"], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "Initial commit"], repoPath);
  return repoPath;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
