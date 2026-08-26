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

The readiness sweep should be a workflow that loads a plugin, gathers deterministic evidence, and asks the model to interpret that evidence; do not add deterministic findings logic back into the workflow.

## Plugins, Tools, Skills, Workflows

- Put domain-specific capabilities under `src/plugins/<domain>/`.
- Give each plugin a small manifest that names its authority and capabilities.
- Keep deterministic evidence recipes with the plugin that uses them.
- Define tool inputs and outputs with TypeBox.
- Put shared tool contracts and generic helpers under `src/tools/`.
- Put durable prompts with the plugin or workflow that owns them.
- Put orchestration under `src/workflows/`.

Adding a domain-specific tool should usually require one plugin-local tool file plus a small plugin registration change.

## Reports

Reports should include enough evidence for a human or future agent to understand the interpretation without re-running the sweep immediately.

Reports should include harness status, model, token usage when available, and tool calls when available. Include any error or skipped reason.

Do not include secret values, access tokens, private keys, or sensitive personal data in reports.
