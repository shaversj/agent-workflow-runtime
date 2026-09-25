import { definePluginManifest } from "../manifest.js";

export const GITHUB_PUBLICATION_WRITE_CREDENTIAL = "github-publication-write";
export const GITHUB_PUBLICATION_AUTHORITY = {
  target: "read-write",
  managedState: "read-write",
  network: "open"
} as const;

export const githubPluginManifest = definePluginManifest({
  name: "github",
  displayName: "GitHub",
  description:
    "Collect GitHub repository intelligence and publish explicitly approved coding proposals.",
  capabilities: [
    "repository-intelligence",
    "ci-context",
    "pull-request-context",
    "issue-context",
    "release-context",
    "approved-draft-pr"
  ],
  authority: {
    target: "read-write",
    managedState: "read-write",
    network: "open"
  },
  source: {
    id: "github",
    label: "GitHub",
    description: "GitHub repository intelligence and approval-gated publication tools."
  },
  toolDefaults: {
    exposure: "deferred",
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord"],
    authority: {
      target: "read-only",
      managedState: "none",
      network: "open"
    },
    requiredCredentials: []
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
    },
    {
      name: "publish_proposal",
      label: "Publish Approved Draft PR",
      description:
        "Publish the exact human-confirmed coding proposal to a new branch and draft PR. Disabled by default.",
      exposure: "hidden",
      readOnly: false,
      requiresApproval: true,
      allowedSurfaces: ["cli", "discord"],
      authority: GITHUB_PUBLICATION_AUTHORITY,
      requiredCredentials: [GITHUB_PUBLICATION_WRITE_CREDENTIAL]
    },
    {
      name: "reconcile_publication",
      label: "Reconcile Draft PR Publication",
      description:
        "Observe and safely resume an uncertain GitHub publication for the exact approved proposal.",
      exposure: "hidden",
      readOnly: false,
      requiresApproval: true,
      allowedSurfaces: ["cli", "discord"],
      authority: GITHUB_PUBLICATION_AUTHORITY,
      requiredCredentials: [GITHUB_PUBLICATION_WRITE_CREDENTIAL]
    }
  ]
});
