import {
  discordExplicitTargetProvenance,
  OPERATOR_DEFAULT_TARGET_PROVENANCE,
  parseTargetRef,
  validateTargetRef
} from "../../workspaces/index.js";
import type { TargetRef } from "../../workspaces/index.js";

import type { ChatRequestContext, ChatRouterOptions } from "./types.js";

export function createChatRequestContext(
  text: string,
  options: ChatRouterOptions = {}
): ChatRequestContext {
  const sourceText = text.trim();
  const explicitRepoTarget = readOptionValue(sourceText, "repo") ?? readTargetArgument(sourceText);
  const timeoutMs = readPositiveIntegerOption(sourceText, "timeout-ms") ?? options.defaultTimeoutMs;
  const ref = readOptionValue(sourceText, "ref");
  const repositoryTarget = explicitRepoTarget
    ? parseTargetRef(explicitRepoTarget, ref, discordExplicitTargetProvenance())
    : options.defaultRepoPath
      ? parseTargetRef(options.defaultRepoPath, ref, OPERATOR_DEFAULT_TARGET_PROVENANCE)
      : undefined;
  const repoTarget = repositoryTarget ? targetValue(repositoryTarget) : undefined;
  return {
    sourceText,
    ...(explicitRepoTarget && repoTarget ? { explicitRepoTarget: repoTarget } : {}),
    ...(repoTarget ? { repoTarget } : {}),
    ...(repositoryTarget ? { repositoryTarget } : {}),
    ref,
    reportPath: readOptionValue(sourceText, "report") ?? readOptionValue(sourceText, "report-path"),
    model:
      readOptionValue(sourceText, "model") ??
      readOptionValue(sourceText, "harness-model") ??
      options.defaultModel,
    timeoutMs
  };
}

export function resolveAuthenticatedRequestTarget(
  request: Pick<ChatRequestContext, "repositoryTarget">,
  modelToolTarget?: string
): TargetRef | undefined {
  void modelToolTarget;
  return request.repositoryTarget ? validateTargetRef(request.repositoryTarget) : undefined;
}

function readOptionValue(text: string, name: string): string | undefined {
  const pattern = new RegExp(
    String.raw`(?:--${escapeRegExp(name)}|${escapeRegExp(name)}[=:])\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))`,
    "i"
  );
  const match = pattern.exec(text);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? cleanTargetToken(value) : undefined;
}

function readPositiveIntegerOption(text: string, name: string): number | undefined {
  const value = readOptionValue(text, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readTargetArgument(text: string): string | undefined {
  const quotedPath = /(?:"([^"]*(?:\/|\.)[^"]*)"|'([^']*(?:\/|\.)[^']*)')/.exec(text);
  const quotedTarget = quotedPath?.[1] ?? quotedPath?.[2];
  if (quotedTarget) return cleanTargetToken(quotedTarget);
  const token = text
    .split(/\s+/)
    .find(
      (item) =>
        item.startsWith("/") ||
        item.startsWith("./") ||
        item.startsWith("../") ||
        /^(?:https?|ssh|git|file):\/\//i.test(item) ||
        /^[^/@\s]+@[^/:\s]+:.+$/.test(item)
    );
  return token ? cleanTargetToken(token) : undefined;
}

function cleanTargetToken(value: string): string {
  return value
    .trim()
    .replace(/^<(.+)>$/, "$1")
    .replace(/[),.;]+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetValue(target: TargetRef): string {
  return target.kind === "git-url" ? target.url : target.path;
}
