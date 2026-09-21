import { readRemoteUrl, type GitRunnerOptions } from "./workspaces/git.js";

export function remoteUrl(
  repoPath: string,
  options: GitRunnerOptions = {}
): Promise<string | undefined> {
  return readRemoteUrl(repoPath, options);
}
