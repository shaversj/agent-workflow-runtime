# Security and Privacy

## Default Safety Boundary

Agent Ops Kit inspects repositories and writes local readiness artifacts. It
should not mutate inspected source repositories unless a user explicitly asks for
that behavior.

Do not edit, delete, commit, push, open pull requests, call external services, or
change production systems as part of a readiness sweep.

## Secrets

Never store secret values in reports, logs, fixtures, test snapshots, or local
database records.

If a check detects a likely secret, record only safe evidence such as file path,
line number, key name shape, or finding category. Do not copy the secret value.

## Paths and Artifacts

Prefer local paths and relative evidence where possible. Be careful with reports
that may be shared outside the machine, because absolute paths can reveal private
directory names.
