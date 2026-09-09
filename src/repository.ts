import { execFileSync } from "node:child_process";

export function remoteUrl(repoPath: string): string | undefined {
  return gitOutput(repoPath, ["config", "--get", "remote.origin.url"]);
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
