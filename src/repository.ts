import { execFileSync } from "node:child_process";
import path from "node:path";

export function repoName(repoPath: string): string {
  return path.basename(path.resolve(repoPath));
}

export function remoteUrl(repoPath: string): string | undefined {
  return gitOutput(repoPath, ["config", "--get", "remote.origin.url"]);
}

export function defaultBranch(repoPath: string): string | undefined {
  const symbolic = gitOutput(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic) return symbolic.replace(/^origin\//, "");
  return gitOutput(repoPath, ["branch", "--show-current"]);
}

function gitOutput(repoPath: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}
