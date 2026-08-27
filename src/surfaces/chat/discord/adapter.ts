import fs from "node:fs";
import path from "node:path";

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
  const repoPath = response.result?.repoPath;
  const reportPath = response.result?.reportPath;
  if (!repoPath || !reportPath) return [];
  const safeReportPath = safeReportAttachmentPath(repoPath, reportPath);
  if (!safeReportPath) return [];
  return [
    {
      path: safeReportPath,
      name: path.basename(safeReportPath)
    }
  ];
}

function safeReportAttachmentPath(repoPath: string, reportPath: string): string | undefined {
  try {
    const realRepoPath = fs.realpathSync(path.resolve(repoPath));
    const reportDir = path.join(realRepoPath, ".agent-readiness", "reports");
    if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return undefined;
    const realReportDir = fs.realpathSync(reportDir);
    const reportDirRelativePath = path.relative(realRepoPath, realReportDir);
    if (reportDirRelativePath.startsWith("..") || path.isAbsolute(reportDirRelativePath)) {
      return undefined;
    }
    const realReportPath = fs.realpathSync(reportPath);
    const relativePath = path.relative(realReportDir, realReportPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
    if (!realReportPath.endsWith(".md")) return undefined;
    if (!fs.statSync(realReportPath).isFile()) return undefined;
    return realReportPath;
  } catch {
    return undefined;
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
