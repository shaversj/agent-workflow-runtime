import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { TargetRef } from "./types.js";

const AGENT_OPS_HOME_ENV = "AGENT_OPS_HOME";

function agentOpsHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[AGENT_OPS_HOME_ENV] ?? path.join(os.homedir(), ".agent-ops-kit"));
}

export function workspaceCachePath(): string {
  return path.join(agentOpsHome(), "cache", "git");
}

export function workspaceScratchPath(): string {
  return path.join(agentOpsHome(), "workspaces");
}

export function targetStatePath(target: TargetRef): string {
  return path.join(agentOpsHome(), "targets", targetStorageKey(target));
}

export function targetStorageKey(target: TargetRef): string {
  const identity =
    target.kind === "git-url" ? safeGitIdentity(target.url) : path.resolve(target.path);
  return `${target.kind}-${hashText(identity)}`;
}

export function workspaceLeaseId(): string {
  return `lease-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeGitIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/^([^@\s]+)@([^:\s]+:.+)$/i, "$2");
  }
}
