import { definePluginManifest } from "../manifest.js";

export const githubPluginManifest = definePluginManifest({
  name: "github",
  displayName: "GitHub",
  description:
    "Collect read-only GitHub repository, pull request, issue, release, and workflow context.",
  capabilities: [
    "repository-intelligence",
    "ci-context",
    "pull-request-context",
    "issue-context",
    "release-context"
  ],
  authority: {
    target: "read-only",
    managedState: "none",
    network: "open"
  },
  source: {
    id: "github",
    label: "GitHub",
    description: "Read-only GitHub repository intelligence tools."
  },
  toolDefaults: {
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord"]
  },
  tools: [
    {
      name: "get_repository_context",
      label: "Get GitHub Repository Context",
      description:
        "Return read-only GitHub repository metadata for a GitHub-backed repository target."
    },
    {
      name: "get_actions_status",
      label: "Get GitHub Actions Status",
      description:
        "Return recent GitHub Actions workflow runs for a GitHub-backed repository target."
    },
    {
      name: "get_pull_requests",
      label: "Get GitHub Pull Requests",
      description: "Return recent open pull requests for a GitHub-backed repository target."
    },
    {
      name: "get_issue_themes",
      label: "Get GitHub Issue Themes",
      description: "Return recent open issues for a GitHub-backed repository target."
    },
    {
      name: "get_releases",
      label: "Get GitHub Releases",
      description: "Return recent releases for a GitHub-backed repository target."
    }
  ]
});
