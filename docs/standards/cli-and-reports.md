# CLI and Reports

## CLI

Keep command parsing small and delegate behavior to workflow code under `src/workflows/`.

CLI output should be concise and human-readable. Always show where artifacts were written.

## Readiness Sweeps

Sweeps are read-only by default:

- inspect the requested repository through registered tools
- persist sweep state under `.agent-readiness/`
- write Markdown reports under `.agent-readiness/reports/`
- do not edit source files, commit, push, or open pull requests unless the user explicitly asks

Prefer Makefile entry points:

```bash
make sweep REPO=/path/to/repo
make sweep REPO=/path/to/repo HARNESS_MODEL=MiniMax-M3
```

Use pi-agent-core as the default harness path. The readiness sweep should be a workflow that loads a skill and exposes tools; do not add deterministic sweep logic back into the workflow.

## Tools, Skills, Workflows

- Put tool contracts and handlers under `src/tools/`.
- Define tool inputs and outputs with TypeBox.
- Register tool families in `src/tools/index.ts`.
- Put durable prompts under `src/skills/`.
- Put orchestration under `src/workflows/`.

Adding a tool should usually require one new tool file plus one registry entry.

## Reports

Reports should include enough evidence for a human or future agent to understand the interpretation without re-running the sweep immediately.

Reports should include harness status, model, token usage when available, and tool calls when available. Include any error or skipped reason.

Do not include secret values, access tokens, private keys, or sensitive personal data in reports.
