import path from "node:path";

import { remoteUrl } from "../../repository.js";
import {
  collectGitHubIssues,
  collectGitHubPullRequests,
  collectGitHubReleases,
  collectGitHubRepositoryContext,
  collectGitHubWorkflowRuns,
  type GitHubEvidenceClientOptions
} from "./client.js";
import type {
  GitHubIdentity,
  GitHubIssuesResult,
  GitHubPullRequestsResult,
  GitHubReleasesResult,
  GitHubRepositoryContextResult,
  GitHubWorkflowRunsResult
} from "./schemas.js";

interface OriginLike {
  origin?: string;
  displayOrigin?: string;
}

export async function gatherGitHubRepositoryContextForTarget(
  repoTarget: string,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubRepositoryContextResult> {
  const identity = await resolveGitHubIdentityForTarget(repoTarget, options);
  if (!identity) return notGitHubResult(options);
  return collectGitHubRepositoryContext(identity, options);
}

export async function gatherGitHubWorkflowRunsForTarget(
  repoTarget: string,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubWorkflowRunsResult> {
  const identity = await resolveGitHubIdentityForTarget(repoTarget, options);
  if (!identity) return notGitHubResult(options);
  return collectGitHubWorkflowRuns(identity, options);
}

export async function gatherGitHubPullRequestsForTarget(
  repoTarget: string,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubPullRequestsResult> {
  const identity = await resolveGitHubIdentityForTarget(repoTarget, options);
  if (!identity) return notGitHubResult(options);
  return collectGitHubPullRequests(identity, options);
}

export async function gatherGitHubIssuesForTarget(
  repoTarget: string,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubIssuesResult> {
  const identity = await resolveGitHubIdentityForTarget(repoTarget, options);
  if (!identity) return notGitHubResult(options);
  return collectGitHubIssues(identity, options);
}

export async function gatherGitHubReleasesForTarget(
  repoTarget: string,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubReleasesResult> {
  const identity = await resolveGitHubIdentityForTarget(repoTarget, options);
  if (!identity) return notGitHubResult(options);
  return collectGitHubReleases(identity, options);
}

export function resolveGitHubIdentity(target: string | OriginLike): GitHubIdentity | undefined {
  const candidates = typeof target === "string" ? [target] : [target.displayOrigin, target.origin];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const identity = identityFromGitHubRemote(candidate);
    if (identity) return identity;
  }
  return undefined;
}

export async function resolveGitHubIdentityForTarget(
  target: string | OriginLike,
  options: Pick<GitHubEvidenceClientOptions, "signal"> = {}
): Promise<GitHubIdentity | undefined> {
  const direct = resolveGitHubIdentity(target);
  if (direct || typeof target !== "string") return direct;
  const remote = await localRemoteUrl(target, options);
  return remote ? resolveGitHubIdentity(remote) : undefined;
}

function identityFromGitHubRemote(remote: string): GitHubIdentity | undefined {
  const trimmed = remote.trim();
  const httpsIdentity = identityFromUrl(trimmed);
  if (httpsIdentity) return httpsIdentity;

  const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (!scpMatch) return undefined;
  const owner = scpMatch[1];
  const repo = scpMatch[2];
  if (!owner || !repo) return undefined;
  return githubIdentity(owner, repo);
}

function identityFromUrl(value: string): GitHubIdentity | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const [owner, rawRepo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !rawRepo) return undefined;
    return githubIdentity(owner, rawRepo.replace(/\.git$/i, ""));
  } catch {
    return undefined;
  }
}

function githubIdentity(owner: string, repo: string): GitHubIdentity {
  const normalizedOwner = owner.trim();
  const normalizedRepo = repo.trim().replace(/\.git$/i, "");
  return {
    host: "github.com",
    owner: normalizedOwner,
    repo: normalizedRepo,
    full_name: `${normalizedOwner}/${normalizedRepo}`,
    display_url: `https://github.com/${normalizedOwner}/${normalizedRepo}`
  };
}

async function localRemoteUrl(
  target: string,
  options: Pick<GitHubEvidenceClientOptions, "signal">
): Promise<string | undefined> {
  try {
    return await remoteUrl(path.resolve(target), options);
  } catch {
    return undefined;
  }
}

function collectedAt(options: GitHubEvidenceClientOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function notGitHubResult(options: GitHubEvidenceClientOptions) {
  return {
    available: false as const,
    reason: "not_github" as const,
    message: "Repository target is not backed by github.com.",
    collected_at: collectedAt(options)
  };
}
