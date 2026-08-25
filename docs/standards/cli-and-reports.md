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
make sweep REPO=/path/to/repo INTERPRET=1
make sweep REPO=/path/to/repo INTERPRET=1 INTERPRET_MODEL=MiniMax-M3
```

## Reports

Reports should include enough evidence for a human or future agent to understand
each finding without re-running the sweep immediately.

Do not include secret values, access tokens, private keys, or sensitive personal
data in reports.
