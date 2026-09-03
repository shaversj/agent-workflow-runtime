import { Type, type Static, type TSchema } from "typebox";

import {
  defineRegisteredTool,
  type RegisteredTool,
  type RegisteredToolContext
} from "../../tools/registry.js";
import { definePlugin } from "../manifest.js";
import type { GitHubEvidenceClientOptions } from "./client.js";
import {
  gatherGitHubIssuesForTarget,
  gatherGitHubPullRequestsForTarget,
  gatherGitHubReleasesForTarget,
  gatherGitHubRepositoryContextForTarget,
  gatherGitHubWorkflowRunsForTarget
} from "./evidence.js";
import { githubPluginManifest } from "./manifest.js";
import {
  GitHubIssuesResultSchema,
  GitHubPullRequestsResultSchema,
  GitHubReleasesResultSchema,
  GitHubRepositoryContextResultSchema,
  GitHubWorkflowRunsResultSchema
} from "./schemas.js";

const GitHubTargetParams = Type.Object({
  repo_target: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "GitHub repository target path or URL. Omit only when the current chat request already has a repository target."
    })
  )
});

type GitHubTargetParamsType = Static<typeof GitHubTargetParams>;

const githubPlugin = definePlugin({
  manifest: githubPluginManifest,
  tools: [
    githubTool({
      name: "get_repository_context",
      label: "Get GitHub Repository Context",
      description:
        "Return read-only GitHub repository metadata for a GitHub-backed repository target.",
      resultSchema: GitHubRepositoryContextResultSchema,
      collect: gatherGitHubRepositoryContextForTarget
    }),
    githubTool({
      name: "get_actions_status",
      label: "Get GitHub Actions Status",
      description:
        "Return recent GitHub Actions workflow runs for a GitHub-backed repository target.",
      resultSchema: GitHubWorkflowRunsResultSchema,
      collect: gatherGitHubWorkflowRunsForTarget
    }),
    githubTool({
      name: "get_pull_requests",
      label: "Get GitHub Pull Requests",
      description: "Return recent open pull requests for a GitHub-backed repository target.",
      resultSchema: GitHubPullRequestsResultSchema,
      collect: gatherGitHubPullRequestsForTarget
    }),
    githubTool({
      name: "get_issue_themes",
      label: "Get GitHub Issue Themes",
      description: "Return recent open issues for a GitHub-backed repository target.",
      resultSchema: GitHubIssuesResultSchema,
      collect: gatherGitHubIssuesForTarget
    }),
    githubTool({
      name: "get_releases",
      label: "Get GitHub Releases",
      description: "Return recent releases for a GitHub-backed repository target.",
      resultSchema: GitHubReleasesResultSchema,
      collect: gatherGitHubReleasesForTarget
    })
  ]
});

export const githubTools: RegisteredTool[] = githubPlugin.tools;

function githubTool<TResult>(input: {
  name: string;
  label: string;
  description: string;
  resultSchema: TSchema;
  collect: (repoTarget: string, options: GitHubEvidenceClientOptions) => Promise<TResult> | TResult;
}): RegisteredTool {
  return defineRegisteredTool({
    pluginName: githubPluginManifest.name,
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: GitHubTargetParams,
    resultSchema: input.resultSchema,
    async execute(params: GitHubTargetParamsType, context: RegisteredToolContext, signal) {
      const result = await input.collect(resolveGitHubToolTarget(params, context), {
        signal,
        useAmbientToken: shouldUseAmbientGitHubToken(params, context)
      });
      return {
        result,
        text: renderGitHubToolText(result)
      };
    }
  });
}

function renderGitHubToolText(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function resolveGitHubToolTarget(
  params: GitHubTargetParamsType,
  context: RegisteredToolContext
): string {
  const repoTarget = params.repo_target ?? context.requestContext?.repoTarget;
  if (!repoTarget) throw new Error("Repository target is required.");
  return repoTarget;
}

function shouldUseAmbientGitHubToken(
  params: GitHubTargetParamsType,
  context: RegisteredToolContext
): boolean {
  if (context.surface !== "discord" && context.surface !== "slack") return true;
  if (params.repo_target) return false;
  return Boolean(context.requestContext?.repoTarget && !context.requestContext.explicitRepoTarget);
}
