# Agent Ops Kit

Agent Ops Kit is a tool-centered harness for making repositories easier and safer for AI agents to inspect.

## Purpose

Make repository work inspectable, repeatable, and approval-friendly before adding higher-autonomy behavior.

The current workflow is intentionally narrow:

- accept requests through user-facing surfaces such as CLI and chat adapters
- load the readiness plugin
- enrich GitHub-backed targets with optional read-only repository context
- expose enabled plugin sources through a small tool catalog for chat surfaces
- deterministically gather a compact evidence packet from a repository
- load the plugin's readiness interpretation skill for the LLM
- ask MiniMax to interpret the collected evidence
- write a Markdown report
- record accepted interactions, tool activity, model usage, and delivery in shared local SQLite history
- avoid source edits unless a human explicitly asks

GitHub context supports readiness interpretation only. Sweep reports should not become general
repository health audits, issue triage, pull request review, release readiness, or productivity
analysis.

## Setup

```bash
make install
```

## Usage

Run a read-only readiness sweep:

```bash
# Reads MINIMAX_API_KEY from .env when present.
make sweep REPO=/path/to/repo
make sweep REPO=https://github.com/org/repo REF=main
```

The sweep still records a skipped report when `MINIMAX_API_KEY` is not configured.
Set `GITHUB_TOKEN` or `GH_TOKEN` when sweeping private GitHub repositories or when
you need higher GitHub API limits. GitHub access is read-only and credential values
must not appear in reports, logs, database metadata, or tool output.

Inspect prior runs without rerunning a sweep:

```bash
agent-ops runs list
agent-ops runs list /path/to/repo
agent-ops runs show <run-id>
agent-ops reports latest
agent-ops reports latest /path/to/repo
```

Run IDs are globally scoped integers. Old `<target-key>:<run-id>` references are not supported.

Inspect all accepted interactions locally, including conversations without reports:

```bash
pnpm exec tsx src/cli.ts history list --limit 20 --json
agent-ops history list --source discord --outcome failed --since 2026-09-01T00:00:00Z
agent-ops history show <interaction-id> --limit 50 --json
```

Use `--cursor` with the returned cursor to continue a page with the same filters. Lists cap at
100 interactions; detail pages cap at 100 activities. Inspection is read-only and never calls a
model, creates a checkout, initializes missing state, or recovers unfinished work. Missing history
is empty; corrupt or unsupported history is an error. Full transcripts stay local to CLI and
local browser inspection; Discord inspection tools do not expose them.

### History Inspector

```bash
make web
# Inspect a different runtime home:
AGENT_OPS_HOME=/path/to/agent-ops-home pnpm web
```

Open `http://127.0.0.1:3000` in your browser. The TanStack Start and Tailwind app shows an interaction list beside saved requests, responses, linked runs,
model usage, delivery attempts, and expandable tool inputs/results. Filters use an exact target,
source, outcome, and local date range. Lists show 20 requests per page; activity pages show 50
records. Activity counts describe that page, while model usage covers the interaction.

The visible page refreshes every three seconds after the previous read finishes (ten seconds while
hidden). Selection, expanded records, and reading position remain unchanged. Failed reads are
labeled stale; a saved `running` status is not proof that work is progressing.

Registered Markdown reports open in a wider reader. Raw HTML is omitted, links are inert, images
do not load, and reads stop at 256 KiB with a truncation notice. Missing reports do not hide the
owning interaction. The inspector never runs tools/models, recovers history, or performs cleanup.

This release replaces Electron with a local browser app running on Node 24. SQLite reads stay on
the server. The server binds only to `127.0.0.1`, rejects unexpected hosts and cross-origin history
requests, and accepts only bounded, schema-validated inspection queries. It is not a remotely
deployable or multi-user service. The app does not load `.env` and sends no model keys to the browser.
Set `PORT=3001` when port 3000 is occupied. Use `pnpm dev:web` for local frontend development.

Run the Discord bot surface:

```bash
make discord
```

See [docs/discord.md](docs/discord.md) for bot token, allowlist, intent, and command setup.

Sweep output is written under Agent Ops Kit managed state. Override the default with
`AGENT_OPS_HOME` when you want an isolated state directory:

```text
~/.agent-ops-kit/
  cache/git/
  workspaces/
  history/
    agent-ops.db
    artifacts/
```

Each accepted CLI workflow or authorized Discord request is recorded before work starts.
Messages, logical tool calls, model calls, optional child runs, and optional artifacts belong to
that interaction. Rejected and ambient messages and passive local inspections are not recorded.
Discord source-message claims survive restarts and do not automatically rerun or resend work.

Execution status, capture completeness, and delivery status are independent. Tokens are summed
from model-call records once; unknown usage is labeled unknown, not measured zero. Capability
calls, catalog dispatch/discovery, and deterministic workflow activities are separate categories.

History lives on a local filesystem with owner-only permissions. Captures are redacted and bounded
to 64 KiB per serialized envelope, depth 12, and 2,000 visited nodes; metadata strings cap at 2 KiB.
Omissions are labeled. Hidden reasoning and raw provider/environment objects are excluded. Full
Markdown artifacts are redacted separately and are not truncated to the transcript capture limit.
Redaction is heuristic, and per-record limits do not bound total disk usage.

Recording failure aborts further work. Recovery marks unfinished work interrupted only when a
same-host owner is provably absent; live, foreign, or uncertain owners are not overwritten.
Pending delivery for an absent owner becomes uncertain without changing a completed execution.

This is a clean cutover: old target databases and Markdown reports are not migrated or read.
Legacy removal is a separate preview/review/apply maintenance operation, never a startup action.
See [Database](docs/standards/database.md) before cleanup. Do not run the old binary after cutover.

## Project Shape

```text
src/
  db/          Drizzle schema and local SQLite persistence
  harness/     shared runtime contracts, model setup, Pi tool adapters, progress, timeouts, and usage helpers
  plugins/     domain bundles with manifests, evidence recipes, tools, and skills
  surfaces/    CLI, Discord chat, and local TanStack Start history inspection
  tools/       shared TypeBox tool contracts, tool registry, catalog bridge, and report helpers
  workspaces/  target normalization, managed git checkouts, and workspace leases
  workflows/   orchestration such as the readiness sweep and chat tool router
```

Evidence gathering is deterministic. Sweeps resolve a local git path or Git URL into a managed
workspace lease, inspect that checkout, record the target ref and commit, then clean up the
workspace. Local path sweeps inspect committed git state, not uncommitted working tree changes.
Plugins bundle domain-specific manifests, recipes, tools, and skills. The readiness
plugin owns repository readiness interpretation. The GitHub plugin owns read-only repository
intelligence such as repository metadata, recent Actions runs, open pull requests, open issues,
and releases. The manifest defines plugin source identity, authority, default exposure, default
approval policy, default surface policy, and tool summaries. Registered tools define TypeBox
input/output schemas and execution. The registry indexes plugin tools, and the catalog exposes
plugin sources to chat surfaces. Chat surfaces enable sources such as `readiness` and `github`;
Pi sees stable bridge tools like `searchTools` and `executeTool`; workflows connect tool
execution, model interpretation, persistence, and reporting.
The CLI sweep remains a direct workflow path for predictable use. Run and report inspection
read only Agent Ops Kit managed state; they do not prepare workspaces, clone repositories,
read target files, or call MiniMax.

## Validation

```bash
make format
make lint
make test
make typecheck
make deadcode
make check
pnpm exec playwright install chromium
pnpm test:web
```

The browser suite starts the production server against temporary local history and drives Chromium.
CI installs Chromium and its system dependencies; Electron, Xvfb, and sandbox-helper setup are no
longer required. Test screenshots remain under the ignored `test-results/` directory.
