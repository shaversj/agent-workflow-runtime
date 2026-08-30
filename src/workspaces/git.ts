import { execFileSync } from "node:child_process";

export function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function tryGit(args: string[], cwd?: string): string | undefined {
  try {
    const output = git(args, cwd);
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function resolveGitRoot(repoPath: string): string {
  const root = tryGit(["rev-parse", "--show-toplevel"], repoPath);
  if (!root) throw new Error(`Repository target is not a git working tree: ${repoPath}`);
  return root;
}

export function resolveCommit(repoPath: string, ref = "HEAD"): string {
  const commit = tryGit(["rev-parse", "--verify", `${ref}^{commit}`], repoPath);
  if (!commit) throw new Error(`Could not resolve git ref '${ref}' in ${repoPath}`);
  return commit;
}
