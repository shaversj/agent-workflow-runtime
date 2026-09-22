# History Inspector

Agent Workflow Runtime records accepted interactions in shared local SQLite history before work starts. Requests, messages, logical tool calls, model calls, child runs, delivery attempts, and artifacts belong to the interaction that produced them.

## CLI Inspection

Inspect run and report summaries without rerunning a workflow:

```bash
agent-ops runs list
agent-ops runs list https://github.com/example/example-repository
agent-ops runs show <run-id>
agent-ops reports latest
agent-ops reports latest https://github.com/example/example-repository
```

Run IDs are globally scoped integers. Old `<target-key>:<run-id>` references are unsupported.

Inspect interactions, including conversations without reports:

```bash
agent-ops history list --limit 20 --json
agent-ops history list --source discord --outcome failed --since 2026-09-01T00:00:00Z
agent-ops history show <interaction-id> --limit 50 --json
```

Use the returned cursor to continue a page with the same filters. Interaction lists cap at 100 records and activity pages at 100 records. Inspection is read-only: it does not call a model, prepare a workspace, initialize missing state, or recover unfinished work.

## Browser Inspector

```bash
make web

# Inspect an isolated runtime home:
AGENT_OPS_HOME=/tmp/agent-workflow-runtime-demo pnpm web
```

Open `http://127.0.0.1:3000`. The TanStack Start and Tailwind app shows interactions beside saved requests, responses, linked runs, model usage, delivery attempts, and expandable tool inputs and results.

Filters cover exact target, source, outcome, and local date range. The visible page refreshes three seconds after the previous read finishes, or every ten seconds while hidden. Selection, expanded records, and reading position remain stable. Failed reads are labeled stale; a saved `running` status is not evidence that work is still progressing.

Registered Markdown reports open in a wider reader. Raw HTML is omitted, links are inert, images do not load, and reads stop at 256 KiB with a truncation notice. Missing reports do not hide their owning interaction.

The server binds only to `127.0.0.1`, rejects unexpected hosts and cross-origin history requests, and accepts only bounded, schema-validated queries. SQLite access remains server-side. The inspector does not load `.env`, run tools or models, recover history, or perform cleanup. It is not a remotely deployable or multi-user service.

Use `PORT=3001` when port 3000 is occupied. Use `pnpm dev:web` for frontend development.

## Runtime State

Override the default state location with `AGENT_OPS_HOME`:

```text
~/.agent-ops-kit/
  cache/git/
  workspaces/
  history/
    agent-ops.db
    artifacts/
```

The `agent-ops` CLI name, `AGENT_OPS_*` environment variables, and `~/.agent-ops-kit` state path are compatibility identifiers retained from the project's former name.

Execution status, capture completeness, and delivery status are independent. Token usage is summed from model-call records once; unknown usage stays unknown instead of becoming measured zero. Capability calls, catalog discovery and dispatch, and deterministic workflow activities are separate categories.

History files are created with owner-only permissions. Captures are redacted and bounded to 64 KiB per serialized envelope, depth 12, and 2,000 visited nodes; metadata strings cap at 2 KiB. Full Markdown artifacts are redacted separately and are not truncated to the transcript capture limit. Redaction is heuristic, and per-record limits do not bound total disk usage.

Recording failure stops further work. Recovery marks unfinished work interrupted only when a same-host owner is provably absent; live, foreign, or uncertain owners are not overwritten. Pending delivery for an absent owner becomes uncertain without changing completed execution.

Legacy target databases and reports are not migrated or read. Legacy removal is a preview, review, and apply maintenance operation rather than a startup action. See [Database](standards/database.md) before cleanup.
