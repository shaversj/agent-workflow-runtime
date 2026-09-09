# CLI and Reports

## CLI

Keep command parsing small and delegate behavior to workflow code under `src/workflows/`.

CLI output should be concise and human-readable. Always show where artifacts were written.

Run/report inspection commands should read Agent Ops Kit managed state only. They should not
prepare workspaces, clone repositories, read target repository files, or call an LLM.

Prefer these command shapes:

```bash
agent-ops runs list
agent-ops runs list /path/to/repo
agent-ops runs show <run-id>
agent-ops history list --limit 20 --json
agent-ops history show <interaction-id> --limit 50 --json
agent-ops reports latest
agent-ops reports latest /path/to/repo
```

Inspection output should include status, target, ref, commit, report path, token count, tool-call
count, and failure reason when available. Distinguish unknown usage from observed zero. Label
capability counts separately from dispatch, discovery, and workflow evidence activities.
Interaction UUIDs are distinct from globally scoped integer run IDs; no old task IDs or qualified
run references remain. Full transcripts are local-only, never registered Discord tools.

## Readiness Sweeps

Sweeps are read-only by default:

- resolve the requested local git path or Git URL into a managed workspace lease
- inspect the leased checkout through registered tools
- persist sweep state under `AGENT_OPS_HOME`, defaulting to `~/.agent-ops-kit/`
- write Markdown reports under `AGENT_OPS_HOME/history/artifacts/` and register each artifact
- record the target origin, ref, and commit SHA in the run/report metadata
- include optional read-only GitHub context when the target is backed by `github.com`
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

GitHub context is supporting evidence, not a hard readiness gate. If GitHub data is unavailable,
record that fact safely and let the report explain it as informational unless the workflow itself
depends on that context.

Readiness sweeps should interpret GitHub data only when it affects agent-readiness confidence,
blockers, or operational caveats. Do not let sweep reports drift into general repository health
audits, issue triage, pull request review, release readiness, or productivity analysis.

Optional GitHub enrichment must be bounded. A slow or unavailable GitHub request should degrade to
unavailable GitHub evidence instead of preventing the sweep report from being written.

## Plugins, Tools, Skills, Workflows

- Put domain-specific capabilities under `src/plugins/<domain>/`.
- Give each plugin a TypeBox-validated manifest that names its source identity,
  authority, capabilities, default exposure, default approval policy, default surface policy,
  and tool summaries.
- Use the manifest for plugin-level defaults. Use registered tools for TypeBox input/output
  schemas, execution, and only the metadata overrides that differ from the plugin default.
- Model plugin authority separately for inspected target access, Agent Ops Kit managed-state
  access, and network access.
- Keep deterministic evidence recipes with the plugin that uses them.
- Follow [Runtime Contracts](runtime-contracts.md) for TypeBox boundary validation,
  tool inputs, tool outputs, workflow results, and manual narrowing rules.
- Put shared runtime contracts and helpers under `src/harness/`.
- Put shared tool contracts and generic helpers under `src/tools/`.
- Put durable prompts with the plugin or workflow that owns them.
- Put orchestration under `src/workflows/`.

Adding a domain-specific tool should usually require one plugin-local tool file plus a small plugin registration change.

## Reports

Reports should include enough evidence for a human or future agent to understand the interpretation without re-running the sweep immediately.

Reports should include harness status, model, token usage when available, and tool calls when available. Include any error or skipped reason.

History captures are bounded independently of full, redacted Markdown artifacts. Report lookup
requires a registered artifact under the canonical artifact root, rejecting symlinks and path
escapes. Missing newest reports are explicitly missing; never substitute a filesystem fallback.
Reports are optional: failure before report creation still has an inspectable interaction/run.

Persist the canonical final answer before rendering or sending. Track delivery attempts and
acknowledged surface IDs independently from execution. An ambiguous Discord send is uncertain,
not a reason for a blind retry. Text-only fallback requires definite attachment rejection and
must record that the attachment was omitted. Progress edits are not transcript entries.

Do not include secret values, access tokens, private keys, or sensitive personal data in reports.
Do not include credentialed Git URLs in run/report inspection output, logs, tool results, or chat
replies.
Reports may include sanitized GitHub repository URLs, default branch, recent workflow-run counts,
open pull request samples, open issue samples, release samples, and GitHub API warning summaries.
