import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";

import type { WorkflowProgressEvent } from "../../../harness/types.js";
import { logger } from "../../../logger.js";
import { handleChatMessage } from "../runner.js";
import {
  normalizeDiscordMessage,
  renderDiscordResponse,
  type DiscordOutboundMessage,
  type DiscordInboundMessage
} from "./adapter.js";
import type { DiscordBotConfig } from "./config.js";

interface DiscordMessagePolicyInput {
  isBot: boolean;
  guildId?: string;
  channelId: string;
  mentionedUserIds: Set<string>;
  botUserId: string;
}

interface DiscordDuplicateGuard {
  claim(messageId: string): boolean;
}

interface DiscordBotOptions {
  duplicateGuard?: DiscordDuplicateGuard;
}

export function createDiscordClient(config: DiscordBotConfig, options: DiscordBotOptions = {}) {
  const duplicateGuard = options.duplicateGuard ?? createDiscordDuplicateGuard();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        surface: "discord",
        bot_user_id: readyClient.user.id,
        bot_username: readyClient.user.username
      },
      "discord_bot.ready"
    );
  });

  client.on(Events.MessageCreate, (message) => {
    void handleDiscordMessage(message, config, { duplicateGuard }).catch((error: unknown) => {
      logger.error(
        {
          err: error,
          error_type: error instanceof Error ? error.name : typeof error,
          error: error instanceof Error ? error.message : String(error)
        },
        "discord_bot.message_failed"
      );
    });
  });

  return client;
}

async function handleDiscordMessage(
  message: Message,
  botConfig: DiscordBotConfig,
  options: DiscordBotOptions = {}
) {
  const botUser = message.client.user;
  if (!botUser) return;

  const policyInput = discordPolicyInput(message, botUser.id);
  if (!shouldAcceptDiscordMessage(policyInput, botConfig)) return;
  if (options.duplicateGuard && !options.duplicateGuard.claim(message.id)) {
    logger.info(
      {
        surface: "discord",
        guild_id: message.guildId,
        channel_id: message.channelId,
        message_id: message.id
      },
      "discord_bot.duplicate_ignored"
    );
    return;
  }

  const inbound = buildDiscordInboundMessage(message, botUser.id);
  const chatMessage = normalizeDiscordMessage(inbound);
  if (!chatMessage) return;

  logger.info(
    {
      surface: "discord",
      guild_id: inbound.guildId,
      channel_id: inbound.channelId,
      thread_id: inbound.threadId,
      message_id: inbound.messageId,
      user_id: inbound.authorId
    },
    "discord_bot.message_accepted"
  );

  const statusMessage = await message.reply("Accepted. Routing request...");
  const response = await handleChatMessage(chatMessage, {
    defaultRepoPath: botConfig.defaultRepoPath,
    defaultModel: botConfig.defaultModel,
    defaultTimeoutMs: botConfig.defaultTimeoutMs,
    onProgress: (event) => {
      void updateDiscordStatus(statusMessage, formatDiscordProgress(event));
    }
  });

  try {
    const replies = renderDiscordResponse(response, inbound);
    for (const reply of replies) {
      await sendDiscordReply(message, reply);
    }
  } finally {
    await deleteDiscordStatus(statusMessage);
  }
}

export async function sendDiscordReply(
  message: Pick<Message, "id" | "reply">,
  reply: Pick<DiscordOutboundMessage, "content" | "attachments">
) {
  const files = reply.attachments?.map(
    (attachment) => new AttachmentBuilder(attachment.path, { name: attachment.name })
  );
  try {
    await message.reply({ content: reply.content, files });
  } catch (error) {
    if (!files?.length) throw error;
    logger.warn(
      {
        surface: "discord",
        message_id: message.id,
        attachment_count: files.length,
        error_type: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      },
      "discord_bot.attachment_reply_failed"
    );
    await message.reply({ content: reply.content });
  }
}

export function shouldAcceptDiscordMessage(
  input: DiscordMessagePolicyInput,
  botConfig: Pick<DiscordBotConfig, "allowedGuildIds" | "allowedChannelIds" | "allowDms">
): boolean {
  if (input.isBot) return false;
  if (input.guildId && !isAllowed(input.guildId, botConfig.allowedGuildIds)) return false;
  if (!input.guildId && !botConfig.allowDms) return false;
  if (!isAllowed(input.channelId, botConfig.allowedChannelIds)) return false;
  if (input.guildId && !input.mentionedUserIds.has(input.botUserId)) return false;
  return true;
}

function buildDiscordInboundMessage(message: Message, botUserId: string): DiscordInboundMessage {
  return {
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    threadId: discordThreadId(message),
    messageId: message.id,
    authorId: message.author.id,
    botUserId,
    isBot: message.author.bot,
    content: message.content
  };
}

export function createDiscordDuplicateGuard(ttlMs = 10 * 60 * 1000): DiscordDuplicateGuard {
  const claimedMessages = new Map<string, number>();
  return {
    claim(messageId: string) {
      const now = Date.now();
      for (const [seenMessageId, expiresAt] of claimedMessages) {
        if (expiresAt <= now) claimedMessages.delete(seenMessageId);
      }
      if (claimedMessages.has(messageId)) return false;
      claimedMessages.set(messageId, now + ttlMs);
      return true;
    }
  };
}

function discordPolicyInput(message: Message, botUserId: string): DiscordMessagePolicyInput {
  return {
    isBot: message.author.bot,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    mentionedUserIds: new Set(message.mentions.users.map((user) => user.id)),
    botUserId
  };
}

function discordThreadId(message: Message): string | undefined {
  return message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
    ? message.channelId
    : undefined;
}

function isAllowed(id: string, allowedIds: Set<string>): boolean {
  return allowedIds.size === 0 || allowedIds.has(id);
}

function formatDiscordProgress(event: WorkflowProgressEvent): string | undefined {
  if (event.type === "evidence_started") return "Collecting repository evidence...";
  if (event.type === "evidence_completed") {
    return `Collected evidence from ${event.fileCount} files.`;
  }
  if (event.type === "model_started") {
    return `Waiting for ${event.modelProvider}/${event.model}...`;
  }
  if (event.type === "report_submitted") return `Report submitted: ${event.reportPath}`;
  if (event.type === "timeout") {
    return `Timed out after ${Math.round(event.timeoutMs / 1000)}s.`;
  }
  return undefined;
}

async function updateDiscordStatus(message: Message, content: string | undefined) {
  if (!content) return;
  try {
    await message.edit(content);
  } catch (error) {
    logger.warn(
      {
        surface: "discord",
        message_id: message.id,
        error_type: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      },
      "discord_bot.status_update_failed"
    );
  }
}

async function deleteDiscordStatus(message: Message) {
  try {
    await message.delete();
  } catch (error) {
    logger.warn(
      {
        surface: "discord",
        message_id: message.id,
        error_type: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error)
      },
      "discord_bot.status_delete_failed"
    );
  }
}
