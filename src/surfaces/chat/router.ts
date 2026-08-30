import type { ChatIntent, ChatMessage, ChatRouterOptions } from "./types.js";
import { createChatRequestContext } from "./request-context.js";

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

  if (!isSweepLike(sourceText)) {
    return {
      kind: "unsupported",
      reason: "I can only route readiness sweep requests right now.",
      sourceText
    };
  }

  const request = createChatRequestContext(sourceText, options);
  const repoPath = request.repoTarget;
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
    model: request.model,
    timeoutMs: request.timeoutMs,
    sourceText
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
