# Security and Privacy

## Default Safety Boundary

Agent Workflow Runtime inspects repositories and writes local readiness artifacts. It
should not mutate inspected source repositories unless a user explicitly asks for
that behavior.

Do not edit, delete, commit, push, open pull requests, call external services, or
change production systems as part of a readiness sweep.

The GitHub repository intelligence plugin may call GitHub read-only APIs for repository
metadata, Actions status, open pull requests, open issues, and releases. It must not mutate
GitHub state.

Remote Git mirrors are immutable after publication. Serialize refresh and publication by canonical
target identity with a SQLite fencing token. Failed or recovered owners may remove only their own
unpublished staging path; they must never mutate or delete a successor's mirror.

Chat-supplied GitHub targets must not spend ambient process credentials by default. Use the bot's
GitHub token only for configured or otherwise trusted repository context. Query explicit chat URLs
without credentials unless a documented trusted-target policy says otherwise.

## Isolated Coding And Publication

Coding and GitHub publication are separate, default-disabled capabilities. Require explicit
operator-allowed GitHub targets/profiles and authenticated initiating principals. The coding
runtime stays on the host with model credentials; read/edit/search/commands execute only in
non-root offline workers, without host mounts, home, history, credentials or Docker socket.
Disable repository/global Pi resource discovery, extensions, settings and hooks. Guidance is
bounded redacted text, not authority. Use digest-pinned trusted images, built-in seccomp, dropped
capabilities, no-new-privileges, read-only root filesystem and bounded resources/temporary storage.
Containers are not a hostile multi-tenant security guarantee.

Freeze regular UTF-8 file changes and verify in a fresh worker whose source is root-owned and
read-only to checks. Reject unsupported entries, secret-bearing changes and unavailable/failed
verification; do not silently redact operational code or run checks on the host. Exact private
snapshots live in shared history SQLite with bounded retention; displayed artifacts and transcripts
are separately redacted/bounded. Expiration deletes local private data, not cryptographic traces,
remote branches or already delivered messages.

Publication uses its own scoped credential and narrow Git-data/draft-PR APIs. Approval must be
durable, authenticated, short-lived, single-use and bound to proposal content, base, target, checks,
branch and PR metadata. Recheck policy and base before remote side effects; never force-update,
merge, deploy or silently rebase. Record each remote stage and stop on fatal history failure.
Uncertain outcomes require explicit reconciliation before retries. Never automatically replay
coding/publication on restart or delete a partially published branch.

Discord shutdown closes admission before cancellation, aborts every active request scope, performs
process-owner-scoped worker cleanup, waits only a bounded grace period, and then awaits Discord
transport destruction. Explicit recovery is bound to the original principal and normalized parent
channel, is unavailable while the original run remains active, and performs only durable
interruption plus job-labelled container cleanup. Recovery never reacquires source, invokes a
model, verifies changes, approves, publishes, or replays prior delivery.

## Secrets

Never store secret values in reports, logs, fixtures, test snapshots, or local
database records.

If a check detects a likely secret, record only safe evidence such as file path,
line number, key name shape, or finding category. Do not copy the secret value.

Credentialed Git URLs are rejected at target parsing and never reach clone/fetch. Persist, log,
report, and return sanitized display identities such as `https://github.com/org/repo`.
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

Authorize Discord messages before target parsing or durable claiming. Require a nonempty immutable
user allowlist and at least one immutable guild or channel restriction at startup; configured
dimensions match conjunctively. Reject DMs, bots, webhooks, missing mentions, and authorization
mismatches without history, model, tool, Git, or network activity. Explicit chat targets are
credential-free HTTPS URLs on the exact approved host. A Discord local default requires a separate
user capability, and model tool arguments cannot replace the authenticated request target.

Deduplicate accepted requests by platform, bot/application identity, and source message ID.
Duplicate requests do not replay work or expose the old answer. Keep user-specific conversation
grouping and full transcripts local; existing Discord tools may return only request-scoped run
metadata and registered report content. Reject symlinked or unregistered report paths. Read-only
queries must not recover or mutate interaction state.

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

## Public Source Releases

Keep package publication disabled and treat repository visibility as a separate human-controlled
operation. Before making the source public, scan the current tree and every advertised remote ref,
review all GitHub surfaces that inherit visibility, and route vulnerability reports through GitHub's
private vulnerability reporting. Never place credentials, raw scanner matches, or private source in
issues, pull requests, Actions logs, release artifacts, or public reproductions.
