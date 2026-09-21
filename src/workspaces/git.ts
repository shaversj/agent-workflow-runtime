import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { agentOpsHome } from "./storage.js";
import type { TargetTransportPolicy } from "./types.js";

export interface GitRunnerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  limits?: Partial<GitRepositoryLimits>;
}

export interface GitRepositoryLimits {
  repositoryBytes: number;
  checkoutBytes: number;
  fileCount: number;
  inodeCount: number;
}

interface InternalGitRunnerOptions extends GitRunnerOptions {
  diskBudget?: { path: string; maxBytes: number };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_REPOSITORY_LIMITS: GitRepositoryLimits = {
  repositoryBytes: 512 * 1024 * 1024,
  checkoutBytes: 512 * 1024 * 1024,
  fileCount: 100_000,
  inodeCount: 120_000
};
const TERMINATION_GRACE_MS = 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class GitOperationError extends Error {
  constructor(public readonly category: string) {
    super(category);
    this.name = "GitOperationError";
  }
}

export async function resolveGitRoot(
  repoPath: string,
  options: GitRunnerOptions = {}
): Promise<string> {
  const cwd = validatedExistingPath(repoPath);
  const output = await runGit(["rev-parse", "--show-toplevel"], cwd, "local", options);
  const root = path.resolve(output);
  if (!path.isAbsolute(root)) throw new GitOperationError("git_root_invalid");
  return root;
}

export async function resolveCommit(
  repoPath: string,
  ref = "HEAD",
  options: GitRunnerOptions = {}
): Promise<string> {
  const cwd = validatedExistingPath(repoPath);
  const validatedRef = validateGitRef(ref);
  const output = await runGit(
    ["rev-parse", "--verify", `${validatedRef}^{commit}`],
    cwd,
    "local",
    options
  );
  if (!SHA_PATTERN.test(output)) throw new GitOperationError("git_revision_invalid");
  return output;
}

export async function readRemoteUrl(
  repoPath: string,
  options: GitRunnerOptions = {}
): Promise<string | undefined> {
  try {
    const output = await runGit(
      ["config", "--get", "remote.origin.url"],
      validatedExistingPath(repoPath),
      "local",
      options
    );
    return output || undefined;
  } catch (error) {
    if (error instanceof GitOperationError && error.category === "git_exit_nonzero")
      return undefined;
    throw error;
  }
}

export async function cloneMirror(
  remoteUrl: string,
  destination: string,
  policy: TargetTransportPolicy,
  options: GitRunnerOptions = {}
): Promise<void> {
  const url = validatedRemote(remoteUrl, policy);
  const ownedDestination = validatedOwnedDestination(destination);
  await runGit(
    ["clone", "--mirror", "--no-local", "--no-hardlinks", "--", url, ownedDestination],
    undefined,
    "https",
    {
      ...options,
      diskBudget: {
        path: ownedDestination,
        maxBytes: options.limits?.repositoryBytes ?? DEFAULT_REPOSITORY_LIMITS.repositoryBytes
      }
    }
  );
  await inspectRepository(ownedDestination, undefined, options);
}

export async function fetchMirror(
  remoteUrl: string,
  mirrorPath: string,
  policy: TargetTransportPolicy,
  options: GitRunnerOptions = {}
): Promise<void> {
  const url = validatedRemote(remoteUrl, policy);
  const mirror = validatedOwnedExistingPath(mirrorPath);
  await inspectRepository(mirror, undefined, options);
  await runGit(
    [
      "fetch",
      "--prune",
      "--force",
      "--no-recurse-submodules",
      "--",
      url,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*"
    ],
    mirror,
    "https",
    {
      ...options,
      diskBudget: {
        path: mirror,
        maxBytes: options.limits?.repositoryBytes ?? DEFAULT_REPOSITORY_LIMITS.repositoryBytes
      }
    }
  );
  await inspectRepository(mirror, undefined, options);
}

export async function cloneWithoutCheckout(
  sourcePath: string,
  destination: string,
  options: GitRunnerOptions = {}
): Promise<void> {
  const source = validatedExistingPath(sourcePath);
  rejectUnsupportedRepositoryState(source);
  const ownedDestination = validatedOwnedDestination(destination);
  await runGit(
    ["clone", "--no-checkout", "--no-local", "--no-hardlinks", "--", source, ownedDestination],
    undefined,
    "local",
    options
  );
}

export async function checkoutDetached(
  workspacePath: string,
  commitSha: string,
  options: GitRunnerOptions = {}
): Promise<void> {
  const workspace = validatedOwnedExistingPath(workspacePath);
  const commit = validateCommitSha(commitSha);
  await inspectRepository(workspace, commit, options);
  await runGit(
    ["checkout", "--detach", "--no-recurse-submodules", commit],
    workspace,
    "local",
    options
  );
}

export async function inspectRepository(
  repoPath: string,
  commitSha: string | undefined,
  options: GitRunnerOptions = {}
): Promise<void> {
  const repository = validatedExistingPath(repoPath);
  const limits = { ...DEFAULT_REPOSITORY_LIMITS, ...options.limits };
  rejectUnsupportedRepositoryState(repository);
  const objectStats = await runGit(["count-objects", "-v"], repository, "local", options);
  if (objectStorageBytes(objectStats) > limits.repositoryBytes) {
    throw new GitOperationError("git_repository_too_large");
  }
  if (!commitSha) return;

  const commit = validateCommitSha(commitSha);
  const tree = await runGit(["ls-tree", "-r", "-l", "-z", commit], repository, "local", {
    ...options,
    maxOutputBytes: Math.max(options.maxOutputBytes ?? 0, 16 * 1024 * 1024)
  });
  const entries = tree ? tree.split("\0").filter(Boolean) : [];
  if (entries.length > limits.fileCount || entries.length + 1 > limits.inodeCount) {
    throw new GitOperationError("git_checkout_file_limit");
  }
  let checkoutBytes = 0;
  const attributesPaths: string[] = [];
  for (const entry of entries) {
    const match = /^\d+ \w+ [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(entry);
    if (!match) throw new GitOperationError("git_tree_invalid");
    const size = match[1];
    const filePath = match[2];
    if (!filePath || filePath.startsWith("/") || filePath.split("/").includes("..")) {
      throw new GitOperationError("git_tree_path_invalid");
    }
    if (size !== "-") checkoutBytes += Number(size);
    if (checkoutBytes > limits.checkoutBytes) {
      throw new GitOperationError("git_checkout_too_large");
    }
    if (filePath.endsWith(".gitattributes")) attributesPaths.push(filePath);
  }
  if (entries.some((entry) => entry.endsWith("\t.gitmodules"))) {
    throw new GitOperationError("git_submodules_unsupported");
  }
  if (attributesPaths.length > 128) throw new GitOperationError("git_attributes_file_limit");
  for (const attributesPath of attributesPaths) {
    const attributes = await runGit(["show", `${commit}:${attributesPath}`], repository, "local", {
      ...options,
      maxOutputBytes: 64 * 1024
    });
    if (/filter\s*=\s*lfs|filter=lfs/i.test(attributes)) {
      throw new GitOperationError("git_lfs_unsupported");
    }
  }
}

async function runGit(
  operationArgs: readonly string[],
  cwd: string | undefined,
  protocol: "local" | "https",
  options: InternalGitRunnerOptions
): Promise<string> {
  if (options.signal?.aborted) throw new GitOperationError("git_aborted");
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = positiveLimit(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES);
  const args = [...fixedGitConfig(protocol), ...operationArgs];

  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnvironment(protocol),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let failure: GitOperationError | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const diskBudgetTimer = options.diskBudget
      ? setInterval(() => {
          if (
            options.diskBudget &&
            directoryBytes(options.diskBudget.path) > options.diskBudget.maxBytes
          ) {
            terminate("git_repository_too_large");
          }
        }, 50)
      : undefined;

    const terminate = (category: string) => {
      if (failure) return;
      failure = new GitOperationError(category);
      killProcessTree(child.pid, "SIGTERM");
      terminationTimer = setTimeout(
        () => killProcessTree(child.pid, "SIGKILL"),
        TERMINATION_GRACE_MS
      );
    };
    const collect = (chunk: Buffer, keep: boolean) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate("git_output_limit");
        return;
      }
      if (keep) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => terminate("git_spawn_failed"));
    const onAbort = () => terminate("git_aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const deadlineTimer = setTimeout(() => terminate("git_timeout"), timeoutMs);

    child.on("close", (code) => {
      clearTimeout(deadlineTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (diskBudgetTimer) clearInterval(diskBudgetTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new GitOperationError("git_exit_nonzero"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function fixedGitConfig(protocol: "local" | "https"): string[] {
  return [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "diff.external=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.required=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "http.followRedirects=false",
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${protocol === "https" ? "https" : "file"}.allow=always`
  ];
}

function gitEnvironment(protocol: "local" | "https"): NodeJS.ProcessEnv {
  const home = agentOpsHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    LANG: "C",
    LC_ALL: "C",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: protocol === "https" ? "https" : "file"
  };
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The child may have exited between the failure signal and cleanup.
  }
}

function rejectUnsupportedRepositoryState(repoPath: string): void {
  const gitDirectory = repoPath.endsWith(".git") ? repoPath : path.join(repoPath, ".git");
  if (fs.existsSync(path.join(gitDirectory, "objects", "info", "alternates"))) {
    throw new GitOperationError("git_alternates_unsupported");
  }
  if (fs.existsSync(path.join(gitDirectory, "shallow"))) {
    throw new GitOperationError("git_shallow_unsupported");
  }
}

function validatedRemote(remoteUrl: string, policy: TargetTransportPolicy): string {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new GitOperationError("git_remote_invalid");
  }
  if (
    policy.protocol !== "https" ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname.toLowerCase() !== policy.exactHost ||
    policy.allowRedirects ||
    policy.allowSecondaryFetches
  ) {
    throw new GitOperationError("git_remote_policy_denied");
  }
  return parsed.href;
}

function validatedExistingPath(value: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || value.includes("\0") || !fs.existsSync(resolved)) {
    throw new GitOperationError("git_path_invalid");
  }
  return resolved;
}

function validatedOwnedDestination(value: string): string {
  const resolved = path.resolve(value);
  if (value.includes("\0") || fs.existsSync(resolved)) {
    throw new GitOperationError("git_destination_invalid");
  }
  assertOwnedRealParent(resolved);
  return resolved;
}

function validatedOwnedExistingPath(value: string): string {
  const resolved = validatedExistingPath(value);
  const realHome = fs.realpathSync(agentOpsHome());
  const realPath = fs.realpathSync(resolved);
  if (!isWithin(realHome, realPath)) throw new GitOperationError("git_path_not_owned");
  return realPath;
}

function assertOwnedRealParent(destination: string): void {
  const realHome = fs.realpathSync(agentOpsHome());
  const realParent = fs.realpathSync(path.dirname(destination));
  if (!isWithin(realHome, realParent)) throw new GitOperationError("git_destination_invalid");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateGitRef(ref: string): string {
  if (
    !ref ||
    ref.length > 1024 ||
    ref !== ref.trim() ||
    ref.startsWith("-") ||
    ref.endsWith(".") ||
    ref.endsWith("/") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    hasForbiddenRefCharacter(ref)
  ) {
    throw new GitOperationError("git_ref_invalid");
  }
  return ref;
}

function hasForbiddenRefCharacter(ref: string): boolean {
  return [...ref].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 32 ||
      codePoint === 127 ||
      "~^:?*[\\".includes(character)
    );
  });
}

function validateCommitSha(value: string): string {
  if (!SHA_PATTERN.test(value)) throw new GitOperationError("git_revision_invalid");
  return value;
}

function objectStorageBytes(output: string): number {
  let kilobytes = 0;
  for (const line of output.split("\n")) {
    const match = /^(size|size-pack):\s+(\d+)$/.exec(line);
    if (match?.[2]) kilobytes += Number(match[2]);
  }
  return kilobytes * 1024;
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  const pending = [root];
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else {
        try {
          bytes += fs.lstatSync(entryPath).size;
        } catch {
          continue;
        }
      }
    }
  }
  return bytes;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
