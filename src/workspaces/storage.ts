import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { TargetRef } from "./types.js";

const AGENT_OPS_HOME_ENV = "AGENT_OPS_HOME";

export function agentOpsHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env[AGENT_OPS_HOME_ENV] ?? path.join(os.homedir(), ".agent-ops-kit"));
}

export function workspaceCachePath(): string {
  return path.join(agentOpsHome(), "cache", "git");
}

export function workspaceScratchPath(): string {
  return path.join(agentOpsHome(), "workspaces");
}

export function historyDirectory(home: string = agentOpsHome()): string {
  return path.join(path.resolve(home), "history");
}

export function historyDatabasePath(home: string = agentOpsHome()): string {
  return path.join(historyDirectory(home), "agent-ops.db");
}

export function historyArtifactsPath(home: string = agentOpsHome()): string {
  return path.join(historyDirectory(home), "artifacts");
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
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "") || "/";
    return parsed.toString();
  } catch {
    return url.replace(/^([^@\s]+)@([^:\s]+:.+)$/i, "$2");
  }
}
