# CLI and Reports

## CLI

Keep command parsing small and delegate behavior to workflow code under `src/workflows/`.

CLI output should be concise and human-readable. Always show where artifacts were written.

## Readiness Sweeps

Sweeps are read-only by default:

- resolve the requested local git path or Git URL into a managed workspace lease
- inspect the leased checkout through registered tools
- persist sweep state under `AGENT_OPS_HOME`, defaulting to `~/.agent-ops-kit/`
- write Markdown reports under the target state `reports/` directory
- record the target origin, ref, and commit SHA in the run/report metadata
- clean up disposable workspaces after the run
- do not edit source files, commit, push, or open pull requests unless the user explicitly asks

Local path sweeps inspect committed git state. They should not read uncommitted working tree files
unless a future workflow explicitly adds and documents snapshot semantics for dirty work.

Prefer Makefile entry points:

```bash
make sweep REPO=/path/to/repo
make sweep REPO=/path/to/repo HARNESS_MODEL=MiniMax-M3
make sweep REPO=https://github.com/org/repo REF=main
```

The readiness sweep should be a workflow that loads a plugin, gathers deterministic evidence, and asks the model to interpret that evidence; do not add deterministic findings logic back into the workflow.

## Plugins, Tools, Skills, Workflows

- Put domain-specific capabilities under `src/plugins/<domain>/`.
- Give each plugin a small manifest that names its authority and capabilities.
- Keep deterministic evidence recipes with the plugin that uses them.
- Define tool inputs and outputs with TypeBox.
- Validate TypeBox tool inputs at the registered-tool execution boundary before invoking plugin code.
- Put shared runtime contracts and helpers under `src/harness/`.
- Put shared tool contracts and generic helpers under `src/tools/`.
- Put durable prompts with the plugin or workflow that owns them.
- Put orchestration under `src/workflows/`.

Adding a domain-specific tool should usually require one plugin-local tool file plus a small plugin registration change.

## Reports

Reports should include enough evidence for a human or future agent to understand the interpretation without re-running the sweep immediately.

Reports should include harness status, model, token usage when available, and tool calls when available. Include any error or skipped reason.

Do not include secret values, access tokens, private keys, or sensitive personal data in reports.
