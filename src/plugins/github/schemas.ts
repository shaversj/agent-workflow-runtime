import { Type, type Static } from "typebox";

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const GitHubIdentitySchema = Type.Object(
  {
    host: Type.Literal("github.com"),
    owner: Type.String({ minLength: 1 }),
    repo: Type.String({ minLength: 1 }),
    full_name: Type.String({ minLength: 1 }),
    display_url: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

const GitHubUnavailableReasonSchema = Type.Union([
  Type.Literal("not_github"),
  Type.Literal("not_found"),
  Type.Literal("rate_limited"),
  Type.Literal("unauthorized"),
  Type.Literal("request_failed"),
  Type.Literal("invalid_response")
]);

const GitHubRepositorySummarySchema = Type.Object(
  {
    full_name: Type.String(),
    html_url: Type.String(),
    description: Type.Optional(NullableString),
    default_branch: Type.Optional(Type.String()),
    visibility: Type.Optional(Type.String()),
    private: Type.Optional(Type.Boolean()),
    archived: Type.Optional(Type.Boolean()),
    fork: Type.Optional(Type.Boolean()),
    primary_language: Type.Optional(NullableString),
    topics: Type.Array(Type.String()),
    stargazers_count: Type.Optional(Type.Number()),
    open_issues_count: Type.Optional(Type.Number()),
    pushed_at: Type.Optional(NullableString),
    updated_at: Type.Optional(NullableString)
  },
  { additionalProperties: false }
);

const GitHubWorkflowRunSummarySchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    event: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    conclusion: Type.Optional(NullableString),
    html_url: Type.Optional(Type.String()),
    updated_at: Type.Optional(NullableString)
  },
  { additionalProperties: false }
);

const GitHubPullRequestSummarySchema = Type.Object(
  {
    number: Type.Number(),
    title: Type.String(),
    state: Type.String(),
    draft: Type.Optional(Type.Boolean()),
    html_url: Type.Optional(Type.String()),
    updated_at: Type.Optional(NullableString)
  },
  { additionalProperties: false }
);

const GitHubIssueSummarySchema = Type.Object(
  {
    number: Type.Number(),
    title: Type.String(),
    state: Type.String(),
    labels: Type.Array(Type.String()),
    html_url: Type.Optional(Type.String()),
    updated_at: Type.Optional(NullableString)
  },
  { additionalProperties: false }
);

const GitHubReleaseSummarySchema = Type.Object(
  {
    tag_name: Type.String(),
    name: Type.Optional(NullableString),
    draft: Type.Optional(Type.Boolean()),
    prerelease: Type.Optional(Type.Boolean()),
    html_url: Type.Optional(Type.String()),
    published_at: Type.Optional(NullableString)
  },
  { additionalProperties: false }
);

const GitHubAvailableEvidenceSchema = Type.Object(
  {
    available: Type.Literal(true),
    identity: GitHubIdentitySchema,
    repository: GitHubRepositorySummarySchema,
    workflow_runs: Type.Array(GitHubWorkflowRunSummarySchema),
    pull_requests: Type.Array(GitHubPullRequestSummarySchema),
    issues: Type.Array(GitHubIssueSummarySchema),
    releases: Type.Array(GitHubReleaseSummarySchema),
    warnings: Type.Array(Type.String()),
    collected_at: Type.String()
  },
  { additionalProperties: false }
);

const GitHubUnavailableEvidenceSchema = Type.Object(
  {
    available: Type.Literal(false),
    reason: GitHubUnavailableReasonSchema,
    message: Type.String(),
    identity: Type.Optional(GitHubIdentitySchema),
    collected_at: Type.String()
  },
  { additionalProperties: false }
);

export const GitHubEvidenceSchema = Type.Union([
  GitHubAvailableEvidenceSchema,
  GitHubUnavailableEvidenceSchema
]);

export const GitHubRepositoryContextResultSchema = Type.Union([
  Type.Object(
    {
      available: Type.Literal(true),
      identity: GitHubIdentitySchema,
      repository: GitHubRepositorySummarySchema,
      collected_at: Type.String()
    },
    { additionalProperties: false }
  ),
  GitHubUnavailableEvidenceSchema
]);

export const GitHubWorkflowRunsResultSchema = Type.Union([
  Type.Object(
    {
      available: Type.Literal(true),
      identity: GitHubIdentitySchema,
      workflow_runs: Type.Array(GitHubWorkflowRunSummarySchema),
      warnings: Type.Array(Type.String()),
      collected_at: Type.String()
    },
    { additionalProperties: false }
  ),
  GitHubUnavailableEvidenceSchema
]);

export const GitHubPullRequestsResultSchema = Type.Union([
  Type.Object(
    {
      available: Type.Literal(true),
      identity: GitHubIdentitySchema,
      pull_requests: Type.Array(GitHubPullRequestSummarySchema),
      warnings: Type.Array(Type.String()),
      collected_at: Type.String()
    },
    { additionalProperties: false }
  ),
  GitHubUnavailableEvidenceSchema
]);

export const GitHubIssuesResultSchema = Type.Union([
  Type.Object(
    {
      available: Type.Literal(true),
      identity: GitHubIdentitySchema,
      issues: Type.Array(GitHubIssueSummarySchema),
      warnings: Type.Array(Type.String()),
      collected_at: Type.String()
    },
    { additionalProperties: false }
  ),
  GitHubUnavailableEvidenceSchema
]);

export const GitHubReleasesResultSchema = Type.Union([
  Type.Object(
    {
      available: Type.Literal(true),
      identity: GitHubIdentitySchema,
      releases: Type.Array(GitHubReleaseSummarySchema),
      warnings: Type.Array(Type.String()),
      collected_at: Type.String()
    },
    { additionalProperties: false }
  ),
  GitHubUnavailableEvidenceSchema
]);

export type GitHubIdentity = Static<typeof GitHubIdentitySchema>;
export type GitHubEvidence = Static<typeof GitHubEvidenceSchema>;
export type GitHubRepositoryContextResult = Static<typeof GitHubRepositoryContextResultSchema>;
export type GitHubWorkflowRunsResult = Static<typeof GitHubWorkflowRunsResultSchema>;
export type GitHubPullRequestsResult = Static<typeof GitHubPullRequestsResultSchema>;
export type GitHubIssuesResult = Static<typeof GitHubIssuesResultSchema>;
export type GitHubReleasesResult = Static<typeof GitHubReleasesResultSchema>;
