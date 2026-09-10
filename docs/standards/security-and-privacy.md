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

## Interaction History

Apply shared redaction before every durable content, metadata, or error write. Match known
application credentials without snapshotting the environment. Omit hidden reasoning, system
prompts, raw provider objects, binary values, accessors, cycles, and unsupported objects.
Cap each serialized capture envelope at 64 KiB UTF-8, traversal depth 12 and 2,000 visited nodes;
metadata strings cap at 2 KiB. Sanitize before clipping or omit unsafe oversized fields, and
persist completeness flags. Full report artifacts use the same secret redaction without the
transcript size cap. These controls do not guarantee detection of arbitrary unlabeled sensitive
text and do not cap total history disk consumption.

Authorize Discord messages before durable claiming. Deduplicate by platform, bot/application
identity, and source message ID. Duplicate requests do not replay work or expose the old answer.
Keep user-specific conversation grouping and full transcripts local; existing Discord tools may
return only request-scoped run metadata and registered report content. Reject symlinked or
unregistered report paths. Read-only queries must not recover or mutate interaction state.

## Browser Inspection

Treat saved transcripts and Markdown as untrusted display data. Keep SQLite and filesystem access
server-only. Bind the server to loopback, reject unexpected Host headers, and require an exact
same-origin JSON POST for history reads. Bound request bodies and validate them with TypeBox.
Browser requests must not choose the history home, arbitrary paths, SQL, or executable operations.

Do not load `.env`, expose model credentials to the client bundle, or log captured content.
The local inspector is not authenticated for remote or multi-user deployment. Keep responses
uncacheable, disable framing, and apply a same-origin Content Security Policy.
Apply the same response policy in development and production, including TanStack-rendered pages.
Read only registered artifacts owned by the selected interaction; reject symlinks and paths outside
the artifact directory. Bound file reads through the verified descriptor. Render raw HTML, links,
and images inertly; do not fetch external resources while displaying captured content.
