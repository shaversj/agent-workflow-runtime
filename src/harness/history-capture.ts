import { types } from "node:util";

import { CaptureEnvelopeSchema, parseHistory } from "./history-schemas.js";
import type { CaptureEnvelope } from "./history-schemas.js";
import { applicationCredentials, redactApplicationText } from "./redaction.js";

const maxBytes = 64 * 1024;
const maxNodes = 2000;
const maxDepth = 12;
const sensitiveKey = /authorization|cookie|token|secret|password|credential|api.?key|private.?key/i;
const safeTokenMetricKey = /^(?:tokens|tokenCount|inputTokens|outputTokens|totalTokens)$/i;
const hiddenKey =
  /thinking|reasoning|system|environment|provider|raw.?response|raw.?request|response.?metadata|request.?options|additional.?kwargs|^(?:env|stack|headers|signature|logprobs|stopReason|api|usage)$/i;

export function captureHistory(value: unknown): CaptureEnvelope {
  return capture(value, maxBytes);
}

/** Metadata uses the same envelope, with a smaller limit on each string and key. */
export function captureHistoryMetadata(value: unknown): CaptureEnvelope {
  return capture(value, 2048);
}

function capture(value: unknown, stringLimit: number): CaptureEnvelope {
  const reasons = new Set<string>();
  const seen = new WeakSet<object>();
  let redacted = false;
  let nodes = 0;
  let bytes = 0;
  const secrets = applicationCredentials();
  const omit = (reason: string): string => {
    reasons.add(reason);
    return "[OMITTED]";
  };
  const sanitize = (text: string): string => {
    // Never inspect a prefix of an unsafe oversized field: a credential may cross its boundary.
    if (text.length > stringLimit || Buffer.byteLength(text) > stringLimit)
      return omit("size_limit");
    const safe = redactApplicationText(text, secrets);
    redacted ||= safe !== text;
    if (Buffer.byteLength(safe) > stringLimit) return omit("size_limit");
    bytes += Buffer.byteLength(safe);
    return bytes > maxBytes ? omit("size_limit") : safe;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (nodes >= maxNodes || depth > maxDepth) return omit("traversal_limit");
    ++nodes;
    if (typeof item === "string") return sanitize(item);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") return omit("unsupported");
    if (types.isProxy(item)) return omit("proxy");
    if (ArrayBuffer.isView(item) || types.isAnyArrayBuffer(item)) return omit("binary");
    if (item === process.env) return omit("hidden_content");
    if (seen.has(item)) return omit("cycle");
    const isArray = Array.isArray(item);
    const isError = types.isNativeError(item);
    const proto: unknown = Object.getPrototypeOf(item);
    if (!isArray && !isError && proto !== Object.prototype && proto !== null)
      return omit("unsupported");
    // Discriminators are read as data descriptors, never through provider getters.
    for (const key of ["type", "role"]) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        descriptor.value.length <= 32 &&
        /^(?:thinking|redacted_thinking|reasoning|reasoning_content|system|developer)$/i.test(
          descriptor.value
        )
      )
        return omit("hidden_content");
    }
    seen.add(item);
    const result: Record<string, unknown> | unknown[] = isArray
      ? []
      : (Object.create(null) as Record<string, unknown>);
    const retain = (key: string): void => {
      if (nodes >= maxNodes) {
        omit("traversal_limit");
        return;
      }
      ++nodes; // Count every inspected property, even hidden keys and accessors.
      if (key.length > stringLimit || Buffer.byteLength(key) > stringLimit) {
        omit("size_limit");
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      const providerIdentity =
        stringLimit === 2048 &&
        /^(?:modelProvider|harnessProvider)$/.test(key) &&
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string";
      if (hiddenKey.test(key) && !providerIdentity) {
        omit("hidden_content");
        return;
      }
      const safeKey = isArray ? key : sanitize(key);
      let safeValue: unknown;
      if (sensitiveKey.test(key) && !safeTokenMetricKey.test(key)) {
        redacted = true;
        safeValue = "[REDACTED]";
      } else if (!descriptor || !("value" in descriptor)) safeValue = omit("accessor");
      else safeValue = visit(descriptor.value, depth + 1);
      if (Array.isArray(result)) result.push(safeValue);
      else result[safeKey] = safeValue;
    };
    if (isError) {
      // Error stacks and custom provider properties are not user-facing error content.
      retain("message");
      omit("error_details");
    } else if (isArray) {
      const length = Object.getOwnPropertyDescriptor(item, "length")!.value as number;
      for (let i = 0; i < length; i++) {
        if (nodes >= maxNodes || bytes >= maxBytes) {
          omit(nodes >= maxNodes ? "traversal_limit" : "size_limit");
          break;
        }
        retain(String(i));
      }
    } else {
      // Do not materialize Object.keys/entries/descriptors for a potentially very wide object.
      for (const key in item) {
        if (nodes >= maxNodes || bytes >= maxBytes) {
          omit(nodes >= maxNodes ? "traversal_limit" : "size_limit");
          break;
        }
        if (Object.hasOwn(item, key)) retain(key);
        else ++nodes;
      }
    }
    seen.delete(item);
    return result;
  };
  let text: string;
  try {
    const safe = visit(value, 0);
    text = typeof safe === "string" ? safe : JSON.stringify(safe);
  } catch {
    text = omit("unsupported");
  }
  const envelope = (): CaptureEnvelope => ({
    text,
    redacted,
    truncated: reasons.has("size_limit") || reasons.has("traversal_limit"),
    omitted: reasons.size > 0,
    incomplete: reasons.size > 0,
    reasons: [...reasons],
    capturedBytes: Buffer.byteLength(text)
  });
  if (Buffer.byteLength(JSON.stringify(envelope())) > maxBytes) {
    omit("size_limit");
    const sanitized = text;
    let low = 0,
      high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      text = sanitized.slice(0, middle);
      if (Buffer.byteLength(JSON.stringify(envelope())) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    // A UTF-16 slice must not leave half of a Unicode code point at the boundary.
    if (low > 0 && /[\uD800-\uDBFF]/.test(sanitized[low - 1]!)) --low;
    text = sanitized.slice(0, low);
  }
  return parseHistory(CaptureEnvelopeSchema, envelope());
}
