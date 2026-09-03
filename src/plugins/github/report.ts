import type { GitHubEvidence } from "./schemas.js";

export function renderGitHubContext(evidence: GitHubEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  if (!evidence.available) {
    const repository = evidence.identity
      ? `\nRepository: \`${evidence.identity.display_url}\``
      : "";
    return `## GitHub Context
${repository}
Status: unavailable (\`${evidence.reason}\`)
Message: ${evidence.message}`;
  }

  const lines = [
    "## GitHub Context",
    "",
    `Repository: \`${evidence.repository.html_url}\``,
    `Default Branch: \`${evidence.repository.default_branch ?? "unknown"}\``,
    `Recent Workflow Runs: ${evidence.workflow_runs.length}`,
    ...formatWorkflowRuns(evidence),
    `Open Pull Requests Sampled: ${evidence.pull_requests.length}`,
    ...formatPullRequests(evidence),
    `Open Issues Sampled: ${evidence.issues.length}`,
    ...formatIssues(evidence),
    `Releases Sampled: ${evidence.releases.length}`,
    ...formatReleases(evidence),
    ...formatWarnings(evidence)
  ];
  return lines.join("\n");
}

function formatWorkflowRuns(evidence: Extract<GitHubEvidence, { available: true }>): string[] {
  return evidence.workflow_runs.map((run) => {
    const status = `${run.status ?? "unknown"}${run.conclusion ? `/${run.conclusion}` : ""}`;
    return `- ${run.name ?? "workflow"}: ${status} on ${run.branch ?? "unknown"}${run.html_url ? ` (${run.html_url})` : ""}`;
  });
}

function formatPullRequests(evidence: Extract<GitHubEvidence, { available: true }>): string[] {
  return evidence.pull_requests.map(
    (pull) =>
      `- #${pull.number} ${pull.title} (${pull.state}${pull.draft ? ", draft" : ""})${pull.html_url ? ` ${pull.html_url}` : ""}`
  );
}

function formatIssues(evidence: Extract<GitHubEvidence, { available: true }>): string[] {
  return evidence.issues.map((issue) => {
    const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
    return `- #${issue.number} ${issue.title}${labels}${issue.html_url ? ` ${issue.html_url}` : ""}`;
  });
}

function formatReleases(evidence: Extract<GitHubEvidence, { available: true }>): string[] {
  return evidence.releases.map((release) => {
    const name = release.name && release.name !== release.tag_name ? ` ${release.name}` : "";
    return `- ${release.tag_name}${name}${release.html_url ? ` ${release.html_url}` : ""}`;
  });
}

function formatWarnings(evidence: Extract<GitHubEvidence, { available: true }>): string[] {
  if (evidence.warnings.length === 0) return [];
  return ["GitHub Warnings:", ...evidence.warnings.map((warning) => `- ${warning}`)];
}
