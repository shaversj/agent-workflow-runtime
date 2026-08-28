import fs from "node:fs";
import path from "node:path";

import { git, resolveCommit, resolveGitRoot } from "./git.js";
import { parseTargetRef, normalizedTargetRef } from "./target.js";
import {
  targetStatePath,
  targetStorageKey,
  workspaceCachePath,
  workspaceLeaseId,
  workspaceScratchPath
} from "./storage.js";
import type { TargetRef, WorkspaceLease, WorkspaceSummary } from "./types.js";

export function prepareWorkspace(input: string | TargetRef, ref?: string): WorkspaceLease {
  const target = typeof input === "string" ? parseTargetRef(input, ref) : input;
  const normalized = normalizedTargetRef(target);
  return normalized.kind === "git-url"
    ? prepareGitUrlWorkspace(normalized)
    : prepareLocalGitWorkspace(normalized);
}

export function workspaceSummary(lease: WorkspaceLease): WorkspaceSummary {
  return {
    id: lease.id,
    source: lease.source,
    origin: lease.displayOrigin,
    displayOrigin: lease.displayOrigin,
    ref: lease.ref,
    commitSha: lease.commitSha,
    path: lease.path,
    statePath: lease.statePath,
    cleanupPolicy: lease.cleanupPolicy
  };
}

function prepareLocalGitWorkspace(target: Extract<TargetRef, { kind: "local-git" }>) {
  const root = resolveGitRoot(path.resolve(target.path));
  const ref = target.ref ?? "HEAD";
  const commitSha = resolveCommit(root, ref);
  return checkoutWorkspace({
    target: { ...target, path: root },
    source: "local-git",
    origin: root,
    displayOrigin: root,
    ref,
    commitSha,
    remote: root,
    stateTarget: { ...target, path: root }
  });
}

function prepareGitUrlWorkspace(target: Extract<TargetRef, { kind: "git-url" }>) {
  const ref = target.ref ?? "HEAD";
  const cachePath = path.join(workspaceCachePath(), `${targetStorageKey(target)}.git`);
  const displayOrigin = safeGitUrlForDisplay(target.url);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  if (fs.existsSync(cachePath)) {
    git(["remote", "set-url", "origin", target.url], cachePath);
    try {
      git(["fetch", "--prune", "origin"], cachePath);
    } finally {
      git(["remote", "set-url", "origin", displayOrigin], cachePath);
    }
  } else {
    try {
      git(["clone", "--mirror", target.url, cachePath]);
      git(["remote", "set-url", "origin", displayOrigin], cachePath);
    } catch (error) {
      fs.rmSync(cachePath, { recursive: true, force: true });
      throw error;
    }
  }

  const commitSha = resolveCommit(cachePath, ref);
  return checkoutWorkspace({
    target,
    source: "git-url",
    origin: target.url,
    displayOrigin,
    ref,
    commitSha,
    remote: cachePath,
    stateTarget: target
  });
}

function checkoutWorkspace(input: {
  target: TargetRef;
  source: WorkspaceLease["source"];
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  remote: string;
  stateTarget: TargetRef;
}): WorkspaceLease {
  const id = workspaceLeaseId();
  const scratchRoot = workspaceScratchPath();
  fs.mkdirSync(scratchRoot, { recursive: true });
  const workspacePath = path.join(scratchRoot, id);
  try {
    git(["clone", "--no-checkout", input.remote, workspacePath]);
    git(["checkout", "--detach", input.commitSha], workspacePath);
  } catch (error) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }

  const statePath = targetStatePath(input.stateTarget);
  fs.mkdirSync(statePath, { recursive: true });

  return {
    id,
    target: input.target,
    source: input.source,
    origin: input.origin,
    displayOrigin: input.displayOrigin,
    ref: input.ref,
    commitSha: input.commitSha,
    path: workspacePath,
    statePath,
    cleanupPolicy: "delete",
    cleanup: () => {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      return Promise.resolve();
    }
  };
}

export function safeGitUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    const hasCredentials = Boolean(parsed.username || parsed.password);
    parsed.username = "";
    parsed.password = "";
    return `${parsed.protocol}//${hasCredentials ? "[REDACTED]@" : ""}${parsed.host}${parsed.pathname}${safeSearch(parsed)}${parsed.hash}`;
  } catch {
    return url.replace(/^([^@\s]+)@([^:\s]+:.+)$/i, "[REDACTED]@$2");
  }
}

function safeSearch(url: URL): string {
  const secretKeys = /(?:api[_-]?key|token|secret|password|credential|authorization)/i;
  for (const key of url.searchParams.keys()) {
    if (secretKeys.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.search;
}
