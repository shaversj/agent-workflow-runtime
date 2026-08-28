import type { ChatIntent, ChatMessage, ChatRouterOptions } from "./types.js";

const sweepPhrases = [
  /\bsweep\b/i,
  /\breadiness\b/i,
  /\bready for agents\b/i,
  /\bagent[- ]ready\b/i,
  /\bcheck\b.*\bagent/i
];

export function routeChatMessage(
  message: ChatMessage,
  options: ChatRouterOptions = {}
): ChatIntent {
  const sourceText = message.text.trim();
  if (!sourceText) {
    return { kind: "unsupported", reason: "The message is empty.", sourceText };
  }

  const request = parseSweepRequest(sourceText);
  if (!request) {
    return {
      kind: "unsupported",
      reason: "I can only route readiness sweep requests right now.",
      sourceText
    };
  }

  const repoPath = request.repoPath ?? options.defaultRepoPath;
  if (!repoPath) {
    return {
      kind: "clarify",
      question: "Which repository should I run the readiness sweep against?",
      sourceText
    };
  }

  return {
    kind: "run_workflow",
    workflow: "readiness_sweep",
    repoPath,
    ref: request.ref,
    model: request.model ?? options.defaultModel,
    timeoutMs: request.timeoutMs ?? options.defaultTimeoutMs,
    sourceText
  };
}

function parseSweepRequest(text: string):
  | {
      repoPath?: string;
      ref?: string;
      model?: string;
      timeoutMs?: number;
    }
  | undefined {
  if (!isSweepLike(text)) return undefined;

  return {
    repoPath: readOptionValue(text, "repo") ?? readTargetArgument(text),
    ref: readOptionValue(text, "ref"),
    model: readOptionValue(text, "model") ?? readOptionValue(text, "harness-model"),
    timeoutMs: readPositiveIntegerOption(text, "timeout-ms")
  };
}

function isSweepLike(text: string): boolean {
  const normalized = text.trim();
  return (
    /^\/?agent-ops\s+sweep\b/i.test(normalized) ||
    /^\/?sweep\b/i.test(normalized) ||
    sweepPhrases.some((phrase) => phrase.test(normalized))
  );
}

function readOptionValue(text: string, name: string): string | undefined {
  const pattern = new RegExp(
    String.raw`(?:--${escapeRegExp(name)}|${escapeRegExp(name)}[=:])\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))`,
    "i"
  );
  const match = pattern.exec(text);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function readPositiveIntegerOption(text: string, name: string): number | undefined {
  const value = readOptionValue(text, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readTargetArgument(text: string): string | undefined {
  const quotedPath = /(?:"([^"]*(?:\/|\.)[^"]*)"|'([^']*(?:\/|\.)[^']*)')/.exec(text);
  if (quotedPath?.[1] ?? quotedPath?.[2]) {
    return quotedPath[1] ?? quotedPath[2];
  }
  const tokenPath = text
    .split(/\s+/)
    .find(
      (token) =>
        token.startsWith("/") ||
        token.startsWith("./") ||
        token.startsWith("../") ||
        isGitUrl(token)
    );
  return tokenPath;
}

function isGitUrl(value: string): boolean {
  return (
    /^(?:https?|ssh|git|file):\/\//i.test(value) || /^[a-z0-9_.-]+@[a-z0-9_.-]+:.+/i.test(value)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
