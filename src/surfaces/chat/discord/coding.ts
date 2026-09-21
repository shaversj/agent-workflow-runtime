import crypto from "node:crypto";
import { types } from "node:util";

import { AttachmentBuilder, ChannelType } from "discord.js";
import type { Message } from "discord.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { beginInteraction } from "../../../harness/interaction.js";
import type { InteractionRecorder } from "../../../harness/interaction.js";
import { captureHistory } from "../../../harness/history-capture.js";
import { logger } from "../../../logger.js";
import { codingProfile, loadCodingPolicy } from "../../../plugins/coding/config.js";
import { CodingGitHubSource } from "../../../plugins/coding/github-source.js";
import { CodingTaskSchema, parseCoding } from "../../../plugins/coding/schemas.js";
import type { CodingTask } from "../../../plugins/coding/schemas.js";
import { prepareCoding } from "../../../workflows/code.js";
import { codingDecision, inspectCoding } from "../../../workflows/coding-approval.js";
import { publishProposal } from "../../../workflows/publish-proposal.js";
import { discordExplicitTargetProvenance, parseTargetRef } from "../../../workspaces/index.js";

const pending = new Map<
  string,
  { task: CodingTask; commit: string; principal: string; conversation: string; expires: number }
>();
const Selector = Type.Object(
  {
    action: Type.Union([
      Type.Literal("confirm"),
      Type.Literal("show"),
      Type.Literal("approve"),
      Type.Literal("reject"),
      Type.Literal("cancel"),
      Type.Literal("expire"),
      Type.Literal("reconcile")
    ]),
    id: Type.String({ pattern: "^[a-zA-Z0-9-]{1,128}$" }),
    digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" }))
  },
  { additionalProperties: false }
);

export function parseDiscordCoding(text: string) {
  const match = /^code\s+(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match) throw new Error("coding_discord_command_invalid");
  const action = match[1],
    args = match[2]!.trim().split(/\s+/);
  if (action === "prepare") {
    const [repository, baseBranch, ...words] = args;
    const task = parseCoding(CodingTaskSchema, { repository, baseBranch, task: words.join(" ") });
    parseTargetRef(
      `https://github.com/${task.repository}`,
      task.baseBranch,
      discordExplicitTargetProvenance()
    );
    if (task.task.length > 1000) throw new Error("coding_discord_task_limit");
    return { action: "prepare" as const, task };
  }
  if (args.length > 2) throw new Error("coding_discord_command_invalid");
  const parsed = parseCoding(Selector, {
    action,
    id: args[0],
    ...(args[1] ? { digest: args[1] } : {})
  });
  if (["approve", "reconcile"].includes(parsed.action) && !parsed.digest)
    throw new Error("coding_digest_required");
  return parsed;
}

/** Only platform-authenticated human messages enter here, never model output or tool arguments. */
export async function handleDiscordCoding(
  message: Message,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  if (message.author.bot) return;
  const principal = `discord:${message.author.id}`;
  const conversation = `${message.guildId ?? "dm"}:${discordParentChannelId(message)}`;
  const recording = beginInteraction(
    {
      source: "discord",
      kind: "coding_command",
      userMessage: text,
      applicationId: message.client.application?.id ?? message.client.user.id,
      sourceMessageId: message.id,
      conversationKey: conversation,
      metadata: { principal }
    },
    { signal }
  );
  try {
    if (!recording.claimed) return;
    const request = parseDiscordCoding(text),
      policy = loadCodingPolicy();
    if (!policy.enabled || !policy.principals.includes(principal))
      throw new Error("coding_permission_denied");
    let content: string, display: string | undefined;
    if (request.action === "prepare") {
      codingProfile(policy, principal, request.task.repository);
      for (const [id, value] of pending) if (value.expires <= Date.now()) pending.delete(id);
      if (pending.size >= 64) throw new Error("coding_confirmation_limit");
      const source = new CodingGitHubSource(policy.readToken);
      const commit = await recording.recordTool(
        {
          name: "coding.resolve_confirmation",
          source: "coding",
          kind: "capability",
          input: request.task
        },
        () => source.base(request.task, recording.signal)
      );
      const id = crypto.randomUUID();
      pending.set(id, {
        task: request.task,
        commit,
        principal,
        conversation,
        expires: Date.now() + 300000
      });
      content = `Confirm isolated, offline coding (no publication):\nRepository: ${request.task.repository}\nBase: ${request.task.baseBranch} @ ${commit}\nTask: ${captureHistory(request.task.task).text}\n\nReply mentioning the bot: code confirm ${id}\nExpires in 5 minutes. Restart discards pending requests.`;
    } else if (request.action === "confirm") {
      const intent = pending.get(request.id);
      if (
        !intent ||
        intent.principal !== principal ||
        intent.conversation !== conversation ||
        intent.expires <= Date.now()
      )
        throw new Error("coding_confirmation_denied");
      pending.delete(request.id);
      const job = await prepareCoding(intent.task, principal, policy, recording, {
        expectedBaseCommit: intent.commit,
        conversationKey: conversation,
        onJob: async (job) => {
          const content = `Started isolated coding job ${job.id}. Mention the bot with code cancel ${job.id} to cancel.`;
          const id = recording.appendMessage({ role: "assistant", content });
          const attempt = recording.deliveryStart({ messageId: id, part: 1, attempt: 1 });
          try {
            const sent = await message.reply({ content, allowedMentions: { parse: [] } });
            recording.deliveryFinish({
              id: attempt,
              status: "acknowledged",
              surfaceMessageId: sent.id
            });
          } catch {
            recording.deliveryFinish({
              id: attempt,
              status: "uncertain",
              error: "coding_discord_acknowledgment_failed"
            });
            throw new Error("coding_discord_acknowledgment_failed");
          }
        }
      });
      const details = inspectCoding(job.id, principal, policy, recording, conversation);
      display = details.display;
      content = `Coding job ${job.id}: ${job.status}\nDigest: ${details.proposal?.digest ?? "none"}\nNo remote writes. Inspect the attached proposal before approval.\nTo publish: code approve ${job.id} ${details.proposal?.digest ?? "<digest>"}`;
    } else {
      const details = inspectCoding(request.id, principal, policy, recording, conversation);
      if (request.action === "show") {
        content = `Job ${request.id}: ${details.job.status}\nDraft PR: ${details.publication?.prUrl ?? "none"}`;
        display = details.display;
      } else if (request.action === "approve" || request.action === "reconcile") {
        const operation = await publishProposal(
          request.id,
          request.digest!,
          principal,
          policy,
          recording,
          request.action === "reconcile",
          undefined,
          conversation
        );
        content = `Job ${request.id}: ${operation.status}\nDraft PR: ${operation.prUrl ?? "none"}`;
      } else
        content = codingDecision(
          { action: request.action, jobId: request.id },
          principal,
          policy,
          recording,
          conversation
        );
    }
    const id = recording.appendMessage({ role: "assistant", content });
    recording.finishRun({ status: "completed" });
    recording.finishInteraction({ status: "completed" });
    await sendDiscordCodingReply(message, content, display, recording, id);
  } catch (error) {
    recording.assertHealthy();
    const content =
      error instanceof Error && /^coding_[a-z_]+$/.test(error.message)
        ? error.message
        : "coding_command_failed";
    const id = recording.appendMessage({ role: "assistant", content });
    const status = ["coding_cancelled", "coding_preparation_interrupted"].includes(content)
      ? "cancelled"
      : "failed";
    recording.finishRun({ status, error: content });
    recording.finishInteraction({ status, error: content });
    await sendDiscordCodingReply(message, content, undefined, recording, id);
  } finally {
    recording.close();
  }
}

function discordParentChannelId(message: Message): string {
  return message.channel.type === ChannelType.PublicThread ||
    message.channel.type === ChannelType.PrivateThread ||
    message.channel.type === ChannelType.AnnouncementThread
    ? (message.channel.parentId ?? message.channelId)
    : message.channelId;
}

const HttpStatusSchema = Type.Integer({ minimum: 400, maximum: 599 });
const DiscordCodeSchema = Type.Integer({ minimum: 0, maximum: 999999 });
const TransportCodeSchema = Type.Union([
  Type.Literal("ECONNRESET"),
  Type.Literal("ECONNREFUSED"),
  Type.Literal("ETIMEDOUT"),
  Type.Literal("ENOTFOUND"),
  Type.Literal("UND_ERR_SOCKET"),
  Type.Literal("UND_ERR_CONNECT_TIMEOUT"),
  Type.Literal("UND_ERR_HEADERS_TIMEOUT"),
  Type.Literal("UND_ERR_BODY_TIMEOUT"),
  Type.Literal("UND_ERR_ABORTED")
]);
const TransportNameSchema = Type.Union([
  Type.Literal("AbortError"),
  Type.Literal("TimeoutError"),
  Type.Literal("RequestAbortedError")
]);

function errorData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export async function sendDiscordCodingReply(
  message: Pick<Message, "id" | "reply">,
  content: string,
  display: string | undefined,
  recording: InteractionRecorder,
  messageId: number
): Promise<void> {
  for (let number = 1; number <= 2; number++) {
    const attempt = recording.deliveryStart({ messageId, part: 1, attempt: number });
    let sent: Message;
    try {
      sent = await message.reply({
        content:
          number === 1
            ? content
            : `${content.slice(0, 1800)}\n\nAttachment could not be sent. The proposal remains saved; use code show with this job ID to retrieve it.`,
        allowedMentions: { parse: [] },
        ...(number === 1 && display
          ? { files: [new AttachmentBuilder(Buffer.from(display), { name: "coding-proposal.md" })] }
          : {})
      });
    } catch (error) {
      // Allowlisted data fields only: Discord exceptions can retain credentials and entire uploads.
      const status = errorData(error, "status"),
        code = errorData(error, "code"),
        causeCode = errorData(errorData(error, "cause"), "code");
      let name: unknown = errorData(error, "name");
      if (
        name === undefined &&
        typeof error === "object" &&
        error !== null &&
        !types.isProxy(error)
      ) {
        try {
          // Native AbortError names live on a branded getter, not an own data property.
          name = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error);
        } catch {
          // Arbitrary exceptions need not be genuine DOMExceptions.
        }
      }
      const httpStatus = Value.Check(HttpStatusSchema, status) ? status : undefined;
      const discordCode = Value.Check(DiscordCodeSchema, code) ? code : undefined;
      const transportCode = Value.Check(TransportCodeSchema, code)
        ? code
        : Value.Check(TransportCodeSchema, causeCode)
          ? causeCode
          : undefined;
      const transportName = Value.Check(TransportNameSchema, name) ? name : undefined;
      const localFailure = code === "ChannelNotCached";
      const rejected = httpStatus !== undefined && httpStatus < 500;
      const attachmentErrors = errorData(errorData(error, "rawError"), "errors");
      const fallback =
        number === 1 &&
        !!display &&
        rejected &&
        (httpStatus === 413 ||
          discordCode === 40005 ||
          (discordCode === 50035 &&
            (errorData(attachmentErrors, "attachments") !== undefined ||
              errorData(attachmentErrors, "files") !== undefined)));
      const deliveryStatus = rejected || localFailure ? "failed" : "uncertain";
      const category = fallback
        ? "coding_discord_attachment_rejected:attachment_omitted"
        : "coding_discord_delivery_failed";
      const diagnostic = [
        category,
        ...(httpStatus === undefined ? [] : [`status=${httpStatus}`]),
        ...(discordCode === undefined ? [] : [`code=${discordCode}`]),
        ...(transportCode === undefined ? [] : [`transport=${transportCode}`]),
        ...(transportName === undefined ? [] : [`transport_name=${transportName}`]),
        ...(localFailure ? ["code=ChannelNotCached"] : [])
      ].join(":");
      let errorType = "unknown";
      if (httpStatus !== undefined) errorType = "discord_api";
      else if (transportCode || transportName) errorType = "discord_transport";
      else if (localFailure) errorType = "discord_local";
      logger.warn(
        {
          interaction_id: recording.interactionId,
          run_id: recording.runId,
          message_id: message.id,
          attempt: number,
          error_type: errorType,
          http_status: httpStatus,
          discord_code: discordCode,
          transport_code: transportCode,
          transport_name: transportName,
          delivery_status: deliveryStatus,
          error: diagnostic,
          err: new Error(category)
        },
        "discord_bot.coding_delivery_failed"
      );
      recording.deliveryFinish({ id: attempt, status: deliveryStatus, error: diagnostic });
      if (fallback) continue;
      return;
    }
    recording.deliveryFinish({ id: attempt, status: "acknowledged", surfaceMessageId: sent.id });
    return;
  }
}
