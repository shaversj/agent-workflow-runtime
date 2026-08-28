import path from "node:path";

import { resolveGitRoot } from "./git.js";
import type { TargetRef } from "./types.js";

export function parseTargetRef(input: string, ref?: string): TargetRef {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Repository target is required.");
  if (isGitUrl(trimmed)) return { kind: "git-url", url: trimmed, ref };
  return { kind: "local-git", path: path.resolve(trimmed), ref };
}

export function targetDisplayName(target: TargetRef): string {
  return target.kind === "git-url" ? target.url : path.resolve(target.path);
}

export function normalizedTargetRef(target: TargetRef): TargetRef {
  if (target.kind === "git-url") return target;
  return { ...target, path: resolveGitRoot(path.resolve(target.path)) };
}

function isGitUrl(value: string): boolean {
  return (
    /^(?:https?|ssh|git|file):\/\//i.test(value) || /^[a-z0-9_.-]+@[a-z0-9_.-]+:.+/i.test(value)
  );
}
