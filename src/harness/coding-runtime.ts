import crypto from "node:crypto";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";

import type { CodingProfile } from "../workspaces/execution.js";
import { redactApplicationText } from "./redaction.js";
import { observedModelUsage } from "./usage.js";

export const CODING_PI_VERSION = "1.3.0";
const CODING_DURABLE_PROTOCOL = `pi-durable@${CODING_PI_VERSION}/coding-v1`;

export function codingProfileFingerprint(
  profile: CodingProfile,
  policy: {
    model: string;
    maxModelCalls: number;
    maxTokens: number;
    maxRepairAttempts?: number;
  }
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        profile,
        model: policy.model,
        maxModelCalls: policy.maxModelCalls,
        maxTokens: policy.maxTokens,
        maxRepairAttempts: policy.maxRepairAttempts ?? 1,
        durableProtocol: CODING_DURABLE_PROTOCOL
      })
    )
    .digest("hex");
}

/** Keep provider payloads out of Durable storage until terminal usage and secret gates pass. */
export function protectDurableProvider(
  provider: Provider,
  guard: { beforeDispatch?: () => Promise<void> } = {}
): Provider {
  return {
    ...provider,
    streamSimple(model, context, options) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          await guard.beforeDispatch?.();
          const source = provider.streamSimple(model, context, {
            ...options,
            maxRetries: 0,
            maxTokens: Math.min(options?.maxTokens ?? 4096, 4096)
          });
          const message = await source.result();
          const reason = containsSensitiveModelOutput(message)
            ? "coding_sensitive_model_output"
            : !observedModelUsage(message)
              ? "coding_usage_unknown"
              : undefined;
          if (reason) {
            const rejected = rejectedMessage(message, reason);
            output.push({ type: "error", reason: "error", error: rejected });
            output.end(rejected);
            return;
          }
          if (
            message.stopReason === "error" ||
            message.stopReason === "aborted" ||
            message.stopReason === "pending"
          ) {
            if (message.stopReason === "pending") throw new Error("coding_model_stopped");
            output.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            output.push({ type: "done", reason: message.stopReason, message });
          }
          output.end(message);
        } catch {
          const failed = failedMessage(model.api, model.provider, model.id);
          output.push({ type: "error", reason: "error", error: failed });
          output.end(failed);
        }
      })();
      return output;
    }
  };
}

function containsSensitiveModelOutput(message: AssistantMessage): boolean {
  for (const item of message.content) {
    if (item.type === "text" && redacted(item.text)) return true;
    if (item.type === "thinking" && redacted(item.thinking)) return true;
    if (item.type === "toolCall") {
      const serialized = JSON.stringify(item.arguments);
      if (redacted(serialized) || sensitiveStringValue(item.arguments)) return true;
      if (item.argumentsError && redacted(item.argumentsError)) return true;
    }
  }
  return message.errorMessage ? redacted(message.errorMessage) : false;
}

function sensitiveStringValue(value: unknown): boolean {
  if (typeof value === "string") return redacted(value);
  if (Array.isArray(value)) return value.some(sensitiveStringValue);
  if (value && typeof value === "object") return Object.values(value).some(sensitiveStringValue);
  return false;
}

function redacted(value: string): boolean {
  return redactApplicationText(value) !== value;
}

function rejectedMessage(message: AssistantMessage, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    api: message.api,
    provider: message.provider,
    model: message.model,
    content: [],
    stopReason: "error",
    errorMessage,
    usage: observedModelUsage(message) ? message.usage : emptyProviderUsage(),
    timestamp: message.timestamp
  };
}

function failedMessage(
  api: AssistantMessage["api"],
  provider: string,
  model: string
): AssistantMessage {
  return {
    role: "assistant",
    api,
    provider,
    model,
    content: [],
    stopReason: "error",
    errorMessage: "coding_model_stopped",
    usage: emptyProviderUsage(),
    timestamp: Date.now()
  };
}

function emptyProviderUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
