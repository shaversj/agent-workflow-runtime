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
import type { InteractionRecorder } from "../../../harness/interaction.js";
import { externalErrorAsError, projectExternalError } from "../../../harness/external-error.js";
import { logger } from "../../../logger.js";
import { beginChatInteraction } from "../../../workflows/chat-agent.js";
import { createChatRequestContext } from "../request-context.js";
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
import { DiscordLifecycle } from "./lifecycle.js";

interface DiscordMessagePolicyInput {
  isBot: boolean;
  isWebhook: boolean;
  authorId: string;
  guildId?: string;
  channelId: string;
  mentionedUserIds: Set<string>;
  botUserId: string;
}

type DiscordMessageOptions = Pick<ChatHandlerOptions, "availableTools" | "signal">;
type DiscordBotOptions = DiscordMessageOptions & {
  lifecycle?: DiscordLifecycle;
};

export function createDiscordClient(config: DiscordBotConfig, options: DiscordBotOptions = {}) {
  const lifecycle = options.lifecycle ?? new DiscordLifecycle();
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
    lifecycle.run(
      (signal) =>
        handleDiscordMessage(message, config, {
          ...(options.availableTools ? { availableTools: options.availableTools } : {}),
          signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal
        }),
      () => {
        logger.error(
          {
            ...projectExternalError("discord_gateway_failed"),
            message_id: message.id
          },
          "discord_bot.message_failed"
        );
      }
    );
  });

  return client;
}

export async function handleDiscordMessage(
  message: Message,
  botConfig: DiscordBotConfig,
  options: DiscordMessageOptions = {}
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

  try {
    const request = createChatRequestContext(chatMessage.text, {
      defaultRepoPath: botConfig.defaultRepoPath
    });
    if (
      request.repositoryTarget?.provenance.source === "operator-default" &&
      request.repositoryTarget.kind === "local-git" &&
      !botConfig.localRepoUserIds.has(inbound.authorId)
    ) {
      return;
    }
  } catch {
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
    try {
      await message.reply("history_recording_failed: request was not started");
    } catch {
      logger.warn(projectExternalError("discord_reply_failed"), "discord_bot.reply_failed");
    }
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
      const disposition = discordDeliveryFailure(error);
      const failure = projectExternalError("discord_reply_failed", {
        interactionId: recording.interactionId,
        runId: recording.runId,
        statusCode: disposition.statusCode,
        attempt: 1,
        part: 1
      });
      recording.deliveryFinish({
        id: acknowledgment,
        status: disposition.status,
        error: failure
      });
      recording.finishRun({ status: "skipped", error: failure });
      recording.finishInteraction({ status: "skipped", error: failure });
      logger.warn(failure, "discord_bot.acknowledgment_failed");
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
  } catch {
    logger.warn(
      projectExternalError("discord_reply_failed", {
        interactionId: recording.interactionId,
        runId: recording.runId
      }),
      "discord_bot.delivery_failed"
    );
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
    const disposition = discordDeliveryFailure(error);
    const failure = projectExternalError("discord_reply_failed", {
      interactionId: delivery?.recording.interactionId,
      runId: delivery?.recording.runId,
      statusCode: disposition.statusCode,
      attempt: 1,
      part: delivery?.part
    });
    if (delivery && attempt !== undefined)
      delivery.recording.deliveryFinish({
        id: attempt,
        status: disposition.status,
        error: failure
      });
    if (!files?.length || !definiteAttachmentRejection(disposition)) {
      throw externalErrorAsError(failure);
    }
    const retry = delivery?.recording.deliveryStart({
      messageId: delivery.messageId,
      part: delivery.part,
      attempt: 2
    });
    try {
      sent = await message.reply({ content: reply.content });
    } catch (retryError) {
      const retryDisposition = discordDeliveryFailure(retryError);
      const retryFailure = projectExternalError("discord_reply_failed", {
        interactionId: delivery?.recording.interactionId,
        runId: delivery?.recording.runId,
        statusCode: retryDisposition.statusCode,
        attempt: 2,
        part: delivery?.part
      });
      if (delivery && retry !== undefined)
        delivery.recording.deliveryFinish({
          id: retry,
          status: retryDisposition.status,
          error: retryFailure
        });
      throw externalErrorAsError(retryFailure);
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

interface DiscordDeliveryFailure {
  status: "failed" | "uncertain";
  statusCode?: number;
  code?: number;
}

function discordDeliveryFailure(error: unknown): DiscordDeliveryFailure {
  const statusCode = safeExternalNumber(error, "status");
  const code = safeExternalNumber(error, "code");
  return {
    status:
      statusCode !== undefined && statusCode >= 400 && statusCode < 500 ? "failed" : "uncertain",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code !== undefined ? { code } : {})
  };
}

function definiteAttachmentRejection(failure: DiscordDeliveryFailure): boolean {
  return failure.status === "failed" && (failure.statusCode === 413 || failure.code === 40005);
}

function safeExternalNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = Reflect.get(value, key) as unknown;
    return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function shouldAcceptDiscordMessage(
  input: DiscordMessagePolicyInput,
  botConfig: Pick<DiscordBotConfig, "allowedUserIds" | "allowedGuildIds" | "allowedChannelIds">
): boolean {
  if (input.isBot || input.isWebhook || !input.guildId) return false;
  if (!botConfig.allowedUserIds.has(input.authorId)) return false;
  if (botConfig.allowedGuildIds.size > 0 && !botConfig.allowedGuildIds.has(input.guildId))
    return false;
  if (botConfig.allowedChannelIds.size > 0 && !botConfig.allowedChannelIds.has(input.channelId))
    return false;
  if (!input.mentionedUserIds.has(input.botUserId)) return false;
  return true;
}

function buildDiscordInboundMessage(message: Message, botUserId: string): DiscordInboundMessage {
  return {
    guildId: message.guildId ?? undefined,
    channelId: discordParentChannelId(message),
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
    isWebhook: Boolean(message.webhookId),
    authorId: message.author.id,
    guildId: message.guildId ?? undefined,
    channelId: discordParentChannelId(message),
    mentionedUserIds: new Set(message.mentions.users.map((user) => user.id)),
    botUserId
  };
}

function discordParentChannelId(message: Message): string {
  return message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
    ? (message.channel.parentId ?? message.channelId)
    : message.channelId;
}

function discordThreadId(message: Message): string | undefined {
  return message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
    ? message.channelId
    : undefined;
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
  } catch {
    logger.warn(
      {
        ...projectExternalError("discord_status_failed"),
        surface: "discord",
        message_id: message.id
      },
      "discord_bot.status_update_failed"
    );
  }
}

async function deleteDiscordStatus(message: Message) {
  try {
    await message.delete();
  } catch {
    logger.warn(
      {
        ...projectExternalError("discord_deletion_failed"),
        surface: "discord",
        message_id: message.id
      },
      "discord_bot.status_delete_failed"
    );
  }
}
