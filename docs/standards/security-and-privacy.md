# Security and Privacy

## Default Safety Boundary

Agent Ops Kit inspects repositories and writes local readiness artifacts. It
should not mutate inspected source repositories unless a user explicitly asks for
that behavior.

Do not edit, delete, commit, push, open pull requests, call external services, or
change production systems as part of a readiness sweep.

The GitHub repository intelligence plugin may call GitHub read-only APIs for repository
metadata, Actions status, open pull requests, open issues, and releases. It must not mutate
GitHub state.

Chat-supplied GitHub targets must not spend ambient process credentials by default. Use the bot's
GitHub token only for configured or otherwise trusted repository context. Query explicit chat URLs
without credentials unless a documented trusted-target policy says otherwise.

## Secrets

Never store secret values in reports, logs, fixtures, test snapshots, or local
database records.

If a check detects a likely secret, record only safe evidence such as file path,
line number, key name shape, or finding category. Do not copy the secret value.

Raw credentialed Git URLs are allowed only at the clone/fetch boundary. Persist, log, report, and
return sanitized display identities such as `https://github.com/org/repo` or a redacted URL.
Do not store GitHub API tokens, authorization headers, or credential-bearing URLs in tool results.
Redact secret-shaped text from GitHub API summaries before storing tool calls, sending evidence to
the model, or rendering reports.

## Paths and Artifacts

Prefer local paths and relative evidence where possible. Be careful with reports
that may be shared outside the machine, because absolute paths can reveal private
directory names.
