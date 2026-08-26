# CLI and Reports

## CLI

Use Typer for command definitions. Keep command functions small and delegate
behavior to reusable workflow code.

CLI output should be concise, human-readable, and evidence-backed. Avoid hiding
where artifacts were written.

## Readiness Sweeps

Sweeps are read-only by default:

- inspect the requested repository
- persist sweep state under `.agent-readiness/`
- write Markdown reports under `.agent-readiness/reports/`
- do not edit source files, commit, push, or open pull requests unless the user
  explicitly asks for that behavior

Prefer Makefile entry points for common sweep modes:

```bash
make sweep REPO=/path/to/repo
make sweep REPO=/path/to/repo HARNESS_MODEL=MiniMax-M3
```

Use the mini-swe-agent harness as the default sweep path. Expose the deterministic
readiness sweep as a read-only `agent_ops_sweep` tool, and have the harness reason
over only the tool output.

Add future harness tool families under `src/agent_ops_kit/harness_tools/`. Each
family should expose a `tools()` function returning `HarnessTool` definitions
with a name, usage string, short description, Pydantic input model, Pydantic
output model, permissions, examples, and handler. Generate schemas from the
models with `model_json_schema()` instead of hand-writing JSON schema literals.
Add the family loader to a named profile in `HARNESS_TOOL_PROFILES`.

The mini-swe-agent environment must execute only registered harness tools and the
completion command. Do not add shell fallback behavior. Keep mini-swe-agent setup
and prompting in `src/agent_ops_kit/harness.py`, and keep generic harness result
handling in `src/agent_ops_kit/harness_result.py`.

## Reports

Reports should include enough evidence for a human or future agent to understand
each finding without re-running the sweep immediately.

Reports should include harness status, model, token usage when available, and
tool calls when available. Include any error or skipped reason.

Do not include secret values, access tokens, private keys, or sensitive personal
data in reports.
