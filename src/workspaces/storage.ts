import crypto from "node:crypto";
import fs from "node:fs";
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

export function ossRulesCachePath(home: string = agentOpsHome()): string {
  return path.join(path.resolve(home), "cache", "ossrules");
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

export function codingExecutionDirectory(jobId: string, home: string = agentOpsHome()): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(jobId)) throw new Error("coding_execution_id_invalid");
  return path.join(historyDirectory(home), "coding", jobId);
}

export function prepareCodingExecutionDatabase(
  jobId: string,
  home: string = agentOpsHome()
): string {
  const directory = codingExecutionDirectory(jobId, home);
  let current = path.resolve(home);
  try {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("coding_execution_path_denied");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(current, { mode: 0o700, recursive: true });
  }
  fs.chmodSync(current, 0o700);
  for (const segment of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("coding_execution_path_denied");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    fs.chmodSync(current, 0o700);
  }
  const databasePath = path.join(directory, "execution.sqlite");
  try {
    if (fs.lstatSync(databasePath).isSymbolicLink())
      throw new Error("coding_execution_path_denied");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const descriptor = fs.openSync(
    databasePath,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600
  );
  fs.closeSync(descriptor);
  fs.chmodSync(databasePath, 0o600);
  return databasePath;
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
