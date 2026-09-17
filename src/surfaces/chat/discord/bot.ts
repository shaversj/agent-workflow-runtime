import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";
import { Agent } from "undici";

import type { WorkflowProgressEvent } from "../../../harness/types.js";
import { RecordingFailure } from "../../../harness/interaction.js";
import type { InteractionRecorder } from "../../../harness/interaction.js";
import { logger } from "../../../logger.js";
import { beginChatInteraction } from "../../../workflows/chat-agent.js";
import { handleChatMessage } from "../runner.js";
import type { ChatHandlerOptions } from "../types.js";
import {
  normalizeDiscordMessage,
  renderDiscordResponse,
  type DiscordOutboundMessage,
  type DiscordInboundMessage
} from "./adapter.js";
import type { DiscordBotConfig } from "./config.js";
import { handleDiscordCoding } from "./coding.js";

interface DiscordMessagePolicyInput {
  isBot: boolean;
  guildId?: string;
  channelId: string;
  mentionedUserIds: Set<string>;
  botUserId: string;
}

type DiscordBotOptions = Pick<ChatHandlerOptions, "availableTools" | "signal">;

export function createDiscordClient(config: DiscordBotConfig, options: DiscordBotOptions = {}) {
  const client = new Client({
    // Pi loads Undici 8 and replaces the global dispatcher; keep Discord's legacy transport isolated.
    // A timed-out message may already exist remotely; retries would bypass delivery tracking.
    rest: { agent: new Agent(), retries: 0 },
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
    void handleDiscordMessage(message, config, options).catch(() => {
      logger.error(
        {
          message_id: message.id
        },
        "discord_bot.message_failed"
      );
    });
  });

  return client;
}

export async function handleDiscordMessage(
  message: Message,
  botConfig: DiscordBotConfig,
  options: DiscordBotOptions = {}
) {
  const botUser = message.client.user;
  if (!botUser) return;

  const policyInput = discordPolicyInput(message, botUser.id);
  if (!shouldAcceptDiscordMessage(policyInput, botConfig)) return;

  const inbound = buildDiscordInboundMessage(message, botUser.id);
  const chatMessage = normalizeDiscordMessage(inbound);
  if (!chatMessage) return;
  if (/^code(?:\s|$)/.test(chatMessage.text)) {
    await handleDiscordCoding(message, chatMessage.text, options.signal);
    return;
  }

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

  let recording: InteractionRecorder;
  try {
    recording = beginChatInteraction(chatMessage, {
      ...options,
      defaultRepoPath: botConfig.defaultRepoPath
    });
  } catch {
    await message.reply("history_recording_failed: request was not started");
    return;
  }
  let statusMessage: Message | undefined;
  let progressing = true;
  try {
    if (!recording.claimed) return;
    const acknowledgment = recording.deliveryStart({
      messageId: recording.userMessageId,
      part: 1,
      attempt: 1
    });
    try {
      statusMessage = await message.reply("Accepted. Routing request...");
      recording.deliveryFinish({
        id: acknowledgment,
        status: "acknowledged",
        surfaceMessageId: statusMessage.id
      });
    } catch (error) {
      recording.deliveryFinish({
        id: acknowledgment,
        status: deliveryFailureStatus(error),
        error: "initial_acknowledgment_failed"
      });
      recording.finishRun({ status: "skipped", error: "initial_acknowledgment_failed" });
      recording.finishInteraction({ status: "skipped", error: "initial_acknowledgment_failed" });
      logger.warn({ interaction_id: recording.interactionId }, "discord_bot.acknowledgment_failed");
      return;
    }
    let answerId: number | undefined;
    const response = await handleChatMessage(chatMessage, {
      ...options,
      recording,
      onResponseRecorded: (id) => {
        answerId = id;
      },
      defaultRepoPath: botConfig.defaultRepoPath,
      defaultModel: botConfig.defaultModel,
      defaultTimeoutMs: botConfig.defaultTimeoutMs,
      enabledPluginSources: botConfig.enabledPluginSources,
      onProgress: (event) => {
        if (progressing && statusMessage && !recording.signal.aborted)
          void updateDiscordStatus(statusMessage, formatDiscordProgress(event));
      }
    });

    progressing = false;
    recording.assertHealthy();
    if (answerId === undefined) throw new Error("chat_response_not_recorded");
    let replies: DiscordOutboundMessage[];
    try {
      replies = renderDiscordResponse(response, inbound);
    } catch {
      const attempt = recording.deliveryStart({ messageId: answerId, part: 1, attempt: 1 });
      recording.deliveryFinish({ id: attempt, status: "failed", error: "response_render_failed" });
      return;
    }
    for (const [index, reply] of replies.entries()) {
      await sendDiscordReply(message, reply, { recording, messageId: answerId, part: index + 1 });
    }
  } catch (error) {
    logger.warn({ interaction_id: recording.interactionId }, "discord_bot.delivery_failed");
    if (error instanceof RecordingFailure) {
      // Storage failure must be visible even when its terminal metadata is pending recovery.
      try {
        await message.reply(error.message);
      } catch {
        /* Local diagnostic remains. */
      }
    }
  } finally {
    progressing = false;
    if (statusMessage) await deleteDiscordStatus(statusMessage);
    recording.close();
  }
}

export async function sendDiscordReply(
  message: Pick<Message, "id" | "reply">,
  reply: Pick<DiscordOutboundMessage, "content" | "attachments">,
  delivery?: { recording: InteractionRecorder; messageId: number; part: number }
) {
  const files = reply.attachments?.map(
    (attachment) => new AttachmentBuilder(attachment.path, { name: attachment.name })
  );
  const attempt = delivery?.recording.deliveryStart({
    messageId: delivery.messageId,
    part: delivery.part,
    attempt: 1
  });
  let sent: Message;
  try {
    sent = await message.reply({ content: reply.content, files });
  } catch (error) {
    const fallback = !!files?.length && definiteAttachmentRejection(error);
    if (delivery && attempt !== undefined)
      delivery.recording.deliveryFinish({
        id: attempt,
        status: deliveryFailureStatus(error),
        error: fallback ? "attachment_rejected:attachment_omitted" : "discord_send_failed"
      });
    if (!fallback) throw error;
    const retry = delivery?.recording.deliveryStart({
      messageId: delivery.messageId,
      part: delivery.part,
      attempt: 2
    });
    try {
      sent = await message.reply({ content: reply.content });
    } catch (retryError) {
      if (delivery && retry !== undefined)
        delivery.recording.deliveryFinish({
          id: retry,
          status: deliveryFailureStatus(retryError),
          error: "discord_text_fallback_failed:attachment_omitted"
        });
      throw retryError;
    }
    if (delivery && retry !== undefined)
      delivery.recording.deliveryFinish({
        id: retry,
        status: "acknowledged",
        surfaceMessageId: sent.id
      });
    return sent;
  }
  if (delivery && attempt !== undefined)
    delivery.recording.deliveryFinish({
      id: attempt,
      status: "acknowledged",
      surfaceMessageId: sent.id
    });
  return sent;
}

function deliveryFailureStatus(error: unknown): "failed" | "uncertain" {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
    ? "failed"
    : "uncertain";
}

function definiteAttachmentRejection(error: unknown): boolean {
  if (deliveryFailureStatus(error) !== "failed" || typeof error !== "object" || error === null)
    return false;
  if ("status" in error && error.status === 413) return true;
  if (!("code" in error)) return false;
  if (error.code === 40005) return true;
  if (error.code !== 50035 || !("rawError" in error)) return false;
  const raw = error.rawError;
  if (typeof raw !== "object" || raw === null || !("errors" in raw)) return false;
  const errors = raw.errors;
  return (
    typeof errors === "object" && errors !== null && ("attachments" in errors || "files" in errors)
  );
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
    applicationId: message.client.application?.id ?? botUserId,
    isBot: message.author.bot,
    content: message.content
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
