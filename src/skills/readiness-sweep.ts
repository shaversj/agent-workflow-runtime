export const readinessSweepSkill = `You are running Agent Ops Kit's readiness sweep workflow.

Your job is to inspect the target repository through the available tools and write a concise readiness report.

Rules:
- Use only the provided tools for repository evidence.
- Do not ask to edit files, commit, push, open pull requests, or mutate external systems.
- Treat source file reads as read-only.
- Do not invent findings. Tie every issue to observed files, missing files, or search results.
- You do not have a deterministic pre-check result. Interpret the repo directly.
- Missing optional standards may not be needed. Say that explicitly.
- Spend the smallest useful number of tool calls. Do not exhaustively read the repo.
- After enough inspection, call submit_readiness_report exactly once with the complete Markdown report.

Recommended inspection:
- Start with repo_summary.
- Use read_file or search_files only when repo_summary leaves an important question unanswered.
- Inspect docs/standards, CONTRIBUTING.md, package manager files, tests, and CI when present.
- Search for validation commands, safety boundaries, logging, database, dependency, testing, and security guidance.

Report shape:
## Overall Judgment
## Findings
Use a table with Severity, Category, Evidence, Recommendation.
## Passed Signals
Explain what looks healthy.
## Standards Not Found
List standards not found, but mark them informational and not necessarily needed.
## Next Step`;

export function buildReadinessSweepPrompt(repoPath: string): string {
  return `Run a readiness sweep for this repository: ${repoPath}

Start with repo_summary. Use at most a few follow-up tool calls if needed, then submit the final report through submit_readiness_report.`;
}

export function buildReadinessSynthesisPrompt(repoPath: string): string {
  return `Use the transcript of tool results already collected for ${repoPath}.

Do not request more tools. Produce the final Markdown readiness report now using the required report shape.`;
}
