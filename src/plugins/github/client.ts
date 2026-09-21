import { Readable } from "node:stream";
import { format as formatUrl } from "node:url";

import { Value } from "typebox/value";
import { request as undiciRequest, type Dispatcher } from "undici";

import { redactEvidenceText, type EvidenceRedactionStats } from "../../harness/redaction.js";
import { requestBoundedJson, type GitHubHttpLimits, type GitHubJsonResponse } from "./http.js";
import { GitHubEvidenceSchema, type GitHubEvidence, type GitHubIdentity } from "./schemas.js";
import type {
  GitHubIssuesResult,
  GitHubPullRequestsResult,
  GitHubReleasesResult,
  GitHubRepositoryContextResult,
  GitHubWorkflowRunsResult
} from "./schemas.js";

export interface GitHubEvidenceClientOptions {
  request?: typeof undiciRequest;
  fetch?: typeof fetch;
  token?: string;
  useAmbientToken?: boolean;
  apiBaseUrl?: string;
  now?: () => Date;
  limits?: Partial<GitHubEvidenceLimits>;
  responseLimits?: Partial<GitHubHttpLimits>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface GitHubEvidenceLimits {
  workflowRuns: number;
  pullRequests: number;
  issues: number;
  releases: number;
}

type JsonResponse = GitHubJsonResponse;

const DEFAULT_LIMITS: GitHubEvidenceLimits = {
  workflowRuns: 5,
  pullRequests: 5,
  issues: 5,
  releases: 3
};
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ISSUE_FETCH_LIMIT = 30;

export async function collectGitHubEvidence(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubEvidence> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const repoPath = `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`;
  const repositoryResponse = await requestJson(`${baseUrl}${repoPath}`, options);

  if (!repositoryResponse.ok) {
    return unavailableFromResponse(identity, repositoryResponse, now);
  }

  const warnings: string[] = [];
  const [workflowRuns, pullRequests, issues, releases] = await Promise.all([
    requestJson(
      `${baseUrl}${repoPath}/actions/runs?per_page=${limits.workflowRuns.toString()}`,
      options
    ),
    requestJson(
      `${baseUrl}${repoPath}/pulls?state=open&per_page=${limits.pullRequests.toString()}`,
      options
    ),
    requestJson(
      `${baseUrl}${repoPath}/issues?state=open&per_page=${issueFetchLimit(limits.issues).toString()}`,
      options
    ),
    requestJson(`${baseUrl}${repoPath}/releases?per_page=${limits.releases.toString()}`, options)
  ]);

  const evidence: GitHubEvidence = {
    available: true,
    identity,
    repository: projectRepository(repositoryResponse.data, identity, redaction),
    workflow_runs: projectWorkflowRuns(workflowRuns, warnings, redaction),
    pull_requests: projectPullRequests(pullRequests, warnings, redaction),
    issues: projectIssues(issues, warnings, redaction, limits.issues),
    releases: projectReleases(releases, warnings, redaction),
    warnings,
    collected_at: now().toISOString()
  };

  if (Value.Check(GitHubEvidenceSchema, evidence)) return evidence;
  return {
    available: false,
    reason: "invalid_response",
    message: "GitHub response could not be projected into the expected evidence schema.",
    identity,
    collected_at: now().toISOString()
  };
}

export async function collectGitHubRepositoryContext(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubRepositoryContextResult> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const response = await requestJson(repositoryUrl(identity, options), options);
  if (!response.ok) return unavailableFromResponse(identity, response, now);
  return {
    available: true,
    identity,
    repository: projectRepository(response.data, identity, redaction),
    collected_at: now().toISOString()
  };
}

export async function collectGitHubWorkflowRuns(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubWorkflowRunsResult> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const repositoryResponse = await requestJson(repositoryUrl(identity, options), options);
  if (!repositoryResponse.ok) return unavailableFromResponse(identity, repositoryResponse, now);
  const warnings: string[] = [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const response = await requestJson(
    `${repositoryUrl(identity, options)}/actions/runs?per_page=${limits.workflowRuns.toString()}`,
    options
  );
  return {
    available: true,
    identity,
    workflow_runs: projectWorkflowRuns(response, warnings, redaction),
    warnings,
    collected_at: now().toISOString()
  };
}

export async function collectGitHubPullRequests(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubPullRequestsResult> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const repositoryResponse = await requestJson(repositoryUrl(identity, options), options);
  if (!repositoryResponse.ok) return unavailableFromResponse(identity, repositoryResponse, now);
  const warnings: string[] = [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const response = await requestJson(
    `${repositoryUrl(identity, options)}/pulls?state=open&per_page=${limits.pullRequests.toString()}`,
    options
  );
  return {
    available: true,
    identity,
    pull_requests: projectPullRequests(response, warnings, redaction),
    warnings,
    collected_at: now().toISOString()
  };
}

export async function collectGitHubIssues(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubIssuesResult> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const repositoryResponse = await requestJson(repositoryUrl(identity, options), options);
  if (!repositoryResponse.ok) return unavailableFromResponse(identity, repositoryResponse, now);
  const warnings: string[] = [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const response = await requestJson(
    `${repositoryUrl(identity, options)}/issues?state=open&per_page=${issueFetchLimit(limits.issues).toString()}`,
    options
  );
  return {
    available: true,
    identity,
    issues: projectIssues(response, warnings, redaction, limits.issues),
    warnings,
    collected_at: now().toISOString()
  };
}

export async function collectGitHubReleases(
  identity: GitHubIdentity,
  options: GitHubEvidenceClientOptions = {}
): Promise<GitHubReleasesResult> {
  const now = options.now ?? (() => new Date());
  const redaction: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const repositoryResponse = await requestJson(repositoryUrl(identity, options), options);
  if (!repositoryResponse.ok) return unavailableFromResponse(identity, repositoryResponse, now);
  const warnings: string[] = [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const response = await requestJson(
    `${repositoryUrl(identity, options)}/releases?per_page=${limits.releases.toString()}`,
    options
  );
  return {
    available: true,
    identity,
    releases: projectReleases(response, warnings, redaction),
    warnings,
    collected_at: now().toISOString()
  };
}

async function requestJson(
  url: string,
  options: GitHubEvidenceClientOptions
): Promise<JsonResponse> {
  try {
    return await requestBoundedJson(url, {
      headers: requestHeaders(githubToken(options)),
      timeoutMs: requestTimeoutMs(options),
      signal: options.signal,
      limits: options.responseLimits,
      request: options.request ?? (options.fetch ? fetchRequestAdapter(options.fetch) : undefined)
    });
  } catch {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      data: undefined
    };
  }
}

function fetchRequestAdapter(fetchImpl: typeof fetch): typeof undiciRequest {
  return async (url, requestOptions) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : formatUrl(url);
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: fetchHeaders(requestOptions?.headers),
      redirect: "manual",
      signal: requestOptions?.signal instanceof AbortSignal ? requestOptions.signal : undefined
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const body = response.body ? Readable.fromWeb(response.body as never) : Readable.from([]);
    return {
      statusCode: response.status,
      headers,
      body,
      trailers: {},
      opaque: undefined,
      context: {}
    } as Dispatcher.ResponseData;
  };
}

function fetchHeaders(headers: Dispatcher.RequestOptions["headers"]): Headers {
  const projected = new Headers();
  if (!headers) return projected;
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (name !== undefined && value !== undefined) projected.append(name, value);
    }
    return projected;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") projected.append(name, item);
      }
    } else if (typeof value === "string") {
      projected.append(name, value);
    }
  }
  return projected;
}

function repositoryUrl(identity: GitHubIdentity, options: GitHubEvidenceClientOptions): string {
  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";
  return `${baseUrl}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`;
}

function githubToken(options: GitHubEvidenceClientOptions): string | undefined {
  if (options.token !== undefined) return options.token;
  if (options.useAmbientToken === false) return undefined;
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function requestTimeoutMs(options: GitHubEvidenceClientOptions): number {
  return options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-workflow-runtime",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function unavailableFromResponse(
  identity: GitHubIdentity,
  response: JsonResponse,
  now: () => Date
): GitHubEvidence {
  const reason =
    response.status === 404
      ? "not_found"
      : response.status === 401 || response.status === 403
        ? rateLimitRemaining(response.headers) === "0"
          ? "rate_limited"
          : "unauthorized"
        : "request_failed";
  return {
    available: false,
    reason,
    message: `GitHub repository context unavailable (${response.status || "request_failed"}).`,
    identity,
    collected_at: now().toISOString()
  };
}

function projectRepository(
  value: unknown,
  identity: GitHubIdentity,
  redaction: EvidenceRedactionStats
) {
  const record = asRecord(value);
  return {
    full_name: safeStringField(record, "full_name", redaction) ?? identity.full_name,
    html_url: safeStringField(record, "html_url", redaction) ?? identity.display_url,
    description: safeNullableStringField(record, "description", redaction),
    default_branch: safeStringField(record, "default_branch", redaction),
    visibility: safeStringField(record, "visibility", redaction),
    private: booleanField(record, "private"),
    archived: booleanField(record, "archived"),
    fork: booleanField(record, "fork"),
    primary_language: safeNullableStringField(record, "language", redaction),
    topics: safeStringArrayField(record, "topics", redaction),
    stargazers_count: numberField(record, "stargazers_count"),
    open_issues_count: numberField(record, "open_issues_count"),
    pushed_at: safeNullableStringField(record, "pushed_at", redaction),
    updated_at: safeNullableStringField(record, "updated_at", redaction)
  };
}

function projectWorkflowRuns(
  response: JsonResponse,
  warnings: string[],
  redaction: EvidenceRedactionStats
) {
  if (!response.ok) {
    warnings.push(`workflow_runs_unavailable:${response.status || "request_failed"}`);
    return [];
  }
  return arrayField(asRecord(response.data), "workflow_runs").map((item) => {
    const record = asRecord(item);
    return {
      name: safeStringField(record, "name", redaction),
      branch: safeStringField(record, "head_branch", redaction),
      event: safeStringField(record, "event", redaction),
      status: safeStringField(record, "status", redaction),
      conclusion: safeNullableStringField(record, "conclusion", redaction),
      html_url: safeStringField(record, "html_url", redaction),
      updated_at: safeNullableStringField(record, "updated_at", redaction)
    };
  });
}

function projectPullRequests(
  response: JsonResponse,
  warnings: string[],
  redaction: EvidenceRedactionStats
) {
  if (!response.ok) {
    warnings.push(`pull_requests_unavailable:${response.status || "request_failed"}`);
    return [];
  }
  return arrayValue(response.data).map((item) => {
    const record = asRecord(item);
    return {
      number: numberField(record, "number") ?? 0,
      title: safeStringField(record, "title", redaction) ?? "",
      state: safeStringField(record, "state", redaction) ?? "unknown",
      draft: booleanField(record, "draft"),
      html_url: safeStringField(record, "html_url", redaction),
      updated_at: safeNullableStringField(record, "updated_at", redaction)
    };
  });
}

function projectIssues(
  response: JsonResponse,
  warnings: string[],
  redaction: EvidenceRedactionStats,
  limit: number
) {
  if (!response.ok) {
    warnings.push(`issues_unavailable:${response.status || "request_failed"}`);
    return [];
  }
  return arrayValue(response.data)
    .filter((item) => !("pull_request" in asRecord(item)))
    .map((item) => {
      const record = asRecord(item);
      return {
        number: numberField(record, "number") ?? 0,
        title: safeStringField(record, "title", redaction) ?? "",
        state: safeStringField(record, "state", redaction) ?? "unknown",
        labels: arrayField(record, "labels").flatMap((label) => {
          const name = safeStringField(asRecord(label), "name", redaction);
          return name ? [name] : [];
        }),
        html_url: safeStringField(record, "html_url", redaction),
        updated_at: safeNullableStringField(record, "updated_at", redaction)
      };
    })
    .slice(0, limit);
}

function projectReleases(
  response: JsonResponse,
  warnings: string[],
  redaction: EvidenceRedactionStats
) {
  if (!response.ok) {
    warnings.push(`releases_unavailable:${response.status || "request_failed"}`);
    return [];
  }
  return arrayValue(response.data).map((item) => {
    const record = asRecord(item);
    return {
      tag_name: safeStringField(record, "tag_name", redaction) ?? "",
      name: safeNullableStringField(record, "name", redaction),
      draft: booleanField(record, "draft"),
      prerelease: booleanField(record, "prerelease"),
      html_url: safeStringField(record, "html_url", redaction),
      published_at: safeNullableStringField(record, "published_at", redaction)
    };
  });
}

function issueFetchLimit(limit: number): number {
  return Math.min(Math.max(limit * 4, limit), MAX_ISSUE_FETCH_LIMIT);
}

function rateLimitRemaining(headers: Headers): string | undefined {
  return headers.get("x-ratelimit-remaining") ?? undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string
): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function safeStringField(
  record: Record<string, unknown>,
  key: string,
  redaction: EvidenceRedactionStats
): string | undefined {
  const value = stringField(record, key);
  return value === undefined ? undefined : redactEvidenceText(value, redaction);
}

function safeNullableStringField(
  record: Record<string, unknown>,
  key: string,
  redaction: EvidenceRedactionStats
): string | null | undefined {
  const value = nullableStringField(record, key);
  return value === undefined || value === null ? value : redactEvidenceText(value, redaction);
}

function safeStringArrayField(
  record: Record<string, unknown>,
  key: string,
  redaction: EvidenceRedactionStats
): string[] {
  return stringArrayField(record, key).map((value) => redactEvidenceText(value, redaction));
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((value): value is string => typeof value === "string");
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  return arrayValue(record[key]);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
