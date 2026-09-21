import fs from "node:fs";
import path from "node:path";

import {
  checkoutDetached,
  cloneMirror,
  cloneMirrorFromLocal,
  cloneWithoutCheckout,
  fetchMirror,
  resolveCommit,
  resolveGitRoot,
  type GitRunnerOptions
} from "./git.js";
import { acquireMirrorLock } from "./lock.js";
import { parseTargetRef, normalizedTargetRef } from "./target.js";
import {
  targetStorageKey,
  workspaceCachePath,
  workspaceLeaseId,
  workspaceScratchPath
} from "./storage.js";
import type { TargetRef, WorkspaceLease, WorkspaceSummary } from "./types.js";

export async function prepareWorkspace(
  input: string | TargetRef,
  ref?: string,
  options: GitRunnerOptions = {}
): Promise<WorkspaceLease> {
  const target = typeof input === "string" ? parseTargetRef(input, ref) : input;
  const normalized = normalizedTargetRef(target);
  return normalized.kind === "git-url"
    ? prepareGitUrlWorkspace(normalized, options)
    : prepareLocalGitWorkspace(normalized, options);
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
    cleanupPolicy: lease.cleanupPolicy
  };
}

async function prepareLocalGitWorkspace(
  target: Extract<TargetRef, { kind: "local-git" }>,
  options: GitRunnerOptions
) {
  const root = await resolveGitRoot(path.resolve(target.path), options);
  const ref = target.ref ?? "HEAD";
  const commitSha = await resolveCommit(root, ref, options);
  return checkoutWorkspace({
    target: { ...target, path: root },
    source: "local-git",
    origin: root,
    displayOrigin: root,
    ref,
    commitSha,
    remote: root,
    options
  });
}

async function prepareGitUrlWorkspace(
  target: Extract<TargetRef, { kind: "git-url" }>,
  options: GitRunnerOptions
) {
  const ref = target.ref ?? "HEAD";
  const cacheKey = targetStorageKey(target);
  const displayOrigin = safeGitUrlForDisplay(target.url);
  fs.mkdirSync(workspaceCachePath(), { recursive: true });
  const lock = await acquireMirrorLock(cacheKey, { signal: options.signal });
  let published = false;
  let workspace: WorkspaceLease | undefined;

  try {
    if (lock.currentPath) {
      try {
        await cloneMirrorFromLocal(lock.currentPath, lock.stagingPath, options);
      } catch (error) {
        fs.rmSync(lock.stagingPath, { recursive: true, force: true });
        if (options.signal?.aborted) throw error;
        await cloneMirror(target.url, lock.stagingPath, target.policy, options);
      }
      await fetchMirror(target.url, lock.stagingPath, target.policy, options);
    } else {
      await cloneMirror(target.url, lock.stagingPath, target.policy, options);
    }

    const commitSha = await resolveCommit(lock.stagingPath, ref, options);
    workspace = await checkoutWorkspace({
      target,
      source: "git-url",
      origin: target.url,
      displayOrigin,
      ref,
      commitSha,
      remote: lock.stagingPath,
      options
    });
    lock.assertOwned();
    const previousPath = lock.publish();
    published = true;
    if (previousPath) fs.rmSync(previousPath, { recursive: true, force: true });
    return workspace;
  } catch (error) {
    if (workspace) await workspace.cleanup();
    throw error;
  } finally {
    if (!published) {
      fs.rmSync(lock.stagingPath, { recursive: true, force: true });
    }
    lock.release();
  }
}

async function checkoutWorkspace(input: {
  target: TargetRef;
  source: WorkspaceLease["source"];
  origin: string;
  displayOrigin: string;
  ref: string;
  commitSha: string;
  remote: string;
  options: GitRunnerOptions;
}): Promise<WorkspaceLease> {
  const id = workspaceLeaseId();
  const scratchRoot = workspaceScratchPath();
  fs.mkdirSync(scratchRoot, { recursive: true });
  const workspacePath = path.join(scratchRoot, id);
  try {
    await cloneWithoutCheckout(input.remote, workspacePath, input.options);
    await checkoutDetached(workspacePath, input.commitSha, input.options);
  } catch (error) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }

  return {
    id,
    target: input.target,
    source: input.source,
    origin: input.origin,
    displayOrigin: input.displayOrigin,
    ref: input.ref,
    commitSha: input.commitSha,
    path: workspacePath,
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
