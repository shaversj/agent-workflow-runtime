export const readinessSweepSkill = `You are running Agent Ops Kit's readiness interpretation workflow.

Your job is to interpret a deterministic repository evidence packet and write a concise readiness report.

Rules:
- Do not ask to edit files, commit, push, open pull requests, or mutate external systems.
- Treat repository evidence as read-only.
- Do not invent findings. Tie every issue to observed files, missing files, or search results.
- Collection is deterministic. Interpretation is your responsibility.
- Missing optional standards may not be needed. Say that explicitly.
- Use only the evidence packet. Tools are unavailable.

Report shape:
## Overall Judgment
## Findings
Use a table with Severity, Category, Evidence, Recommendation.
## Passed Signals
Explain what looks healthy.
## Standards Not Found
List standards not found, but mark them informational and not necessarily needed.
## Next Step`;

export function buildReadinessInterpretationPrompt(repoPath: string, evidence: unknown): string {
  return `Interpret the collected readiness evidence for this repository: ${repoPath}

Evidence packet:

${JSON.stringify(evidence, null, 2)}

Produce the final Markdown readiness report using the required report shape.`;
}
