import path from "node:path";

import { resolveInspectionReportPath } from "../../../db/inspection.js";
import type { ChatMessage, ChatResponse } from "../types.js";

const DISCORD_MESSAGE_LIMIT = 2000;

export interface DiscordInboundMessage {
  guildId?: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  authorId: string;
  content: string;
  botUserId?: string;
  applicationId?: string;
  isBot?: boolean;
}

interface DiscordOutboundAttachment {
  path: string;
  name: string;
}

export interface DiscordOutboundMessage {
  channelId: string;
  threadId?: string;
  replyToMessageId?: string;
  content: string;
  attachments?: DiscordOutboundAttachment[];
}

export function normalizeDiscordMessage(input: DiscordInboundMessage): ChatMessage | undefined {
  if (input.isBot) return undefined;
  const text = stripBotMention(input.content, input.botUserId).trim();
  return {
    platform: "discord",
    applicationId: input.applicationId ?? input.botUserId,
    workspaceId: input.guildId,
    channelId: input.channelId,
    threadId: input.threadId,
    messageId: input.messageId,
    userId: input.authorId,
    text
  };
}

export function renderDiscordResponse(
  response: ChatResponse,
  destination: Pick<DiscordInboundMessage, "channelId" | "threadId" | "messageId">
): DiscordOutboundMessage[] {
  const content = response.text.trim() || "Done.";
  const attachments = discordAttachmentsForResponse(response);
  return chunkDiscordMessage(content).map((chunk, index) => ({
    channelId: destination.channelId,
    threadId: destination.threadId,
    replyToMessageId: destination.messageId,
    content: chunk,
    attachments: index === 0 ? attachments : undefined
  }));
}

function stripBotMention(content: string, botUserId?: string): string {
  if (!botUserId) return content;
  const mentionPattern = new RegExp(String.raw`<@!?${escapeRegExp(botUserId)}>\s*`, "g");
  return content.replace(mentionPattern, "");
}

function chunkDiscordMessage(content: string): string[] {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return [content];

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const splitAt = bestSplitIndex(remaining);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function discordAttachmentsForResponse(response: ChatResponse): DiscordOutboundAttachment[] {
  if (response.kind !== "message") return [];
  const result = response.result;
  if (result?.reportPath === undefined) return [];
  try {
    if (!result.runId || !result.interactionId || !result.target?.origin)
      throw new Error("Report workflow identity is missing");
    const reportPath = resolveInspectionReportPath({
      reportPath: result.reportPath,
      repoTarget: result.target.origin,
      expectedRunId: result.runId,
      expectedInteractionId: result.interactionId
    });
    return [{ path: reportPath, name: path.basename(reportPath) }];
  } catch {
    throw new Error("Report attachment is missing, unsafe, or not registered for this workflow.");
  }
}

function bestSplitIndex(content: string): number {
  const window = content.slice(0, DISCORD_MESSAGE_LIMIT);
  const newlineIndex = window.lastIndexOf("\n");
  if (newlineIndex > DISCORD_MESSAGE_LIMIT * 0.5) return newlineIndex;
  const spaceIndex = window.lastIndexOf(" ");
  if (spaceIndex > DISCORD_MESSAGE_LIMIT * 0.5) return spaceIndex;
  return DISCORD_MESSAGE_LIMIT;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
