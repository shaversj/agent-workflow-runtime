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

### Opt-In Coding

Coding is separate from read-only sweeps and disabled by default. It uses Pi's coding-agent SDK
with worker-backed tools; it never executes repository code on the host. Install/start Docker
Desktop (or a dedicated Linux Docker runtime with built-in seccomp) and provision a trusted,
digest-pinned image before enabling it. Do not use this container backend for hostile multi-tenant
hosting. Images must contain Node for the trusted file protocol and all required dependencies;
network access and implicit dependency downloads are disabled.

Configure `$AGENT_OPS_HOME/.env` using the coding section of `.env.example`, or set
`AGENT_OPS_ENV_FILE` to an absolute operator-owned file before startup. Agent Ops Kit never loads
runtime configuration from the process working directory or a Git checkout. The file and its parent
directory must be owned by the current user and not writable by other users. Allow explicit principals
(`cli:<uid>` or `discord:<user-id>`) and repository profiles with a digest-pinned image,
required verification commands, ignored generated directory names, and the allowed principal.
Profiles are operator configuration, never repository/model configuration. The built-in Node
fixture only proves offline, dependency-free Node work, not arbitrary repository readiness.

```bash
pnpm exec tsx src/cli.ts code prepare owner/repo main "Fix the addition bug"
pnpm exec tsx src/cli.ts code show <job-id>
# Full private proposal inspection locally, including exact changed-file contents:
pnpm exec tsx src/cli.ts code show <job-id> --json
# Requires a human terminal and typing the exact digest after inspection:
pnpm exec tsx src/cli.ts code approve <job-id> --digest <64-hex-digest>
pnpm exec tsx src/cli.ts code reject <job-id>
pnpm exec tsx src/cli.ts code cancel <job-id>
pnpm exec tsx src/cli.ts code recover <job-id>
pnpm exec tsx src/cli.ts code expire <job-id>
pnpm exec tsx src/cli.ts code reconcile <job-id> --digest <64-hex-digest>
```

Preparation pins the base commit, creates an offline non-root worker, records model/tool activity,
exports regular UTF-8 files, and runs operator-required checks in a fresh worker with root-owned
read-only source. Checks may write temporary data only under `/tmp`; profiles requiring source-tree
build outputs are unsupported in this release. Symlinks, submodules, binary files, oversized
snapshots, secret-bearing changed content, unknown model usage, failed/truncated checks, and
unavailable dependencies stop preparation or block publication. Root filesystem, capabilities,
networking, memory, CPU, PID count, command output and deadlines are bounded. Defaults: 20 minutes,
30 model calls, 100,000 aggregate observed tokens, 128 tools, 2-minute commands, 64 KiB command
output, 2 CPU/2 GiB/128 PIDs, 200 changed files/10 MiB changed content. Exact private proposals
remain in shared SQLite; redacted bounded Markdown is registered for history/browser inspection.

The coding SDK and file tools use `/workspace` as the working directory. The model receives
the operator-configured checks for its worker; repository guidance cannot authorize dependency
installation or replace fresh-worker verification. Model-call and token-budget exhaustion return
their specific failure reasons rather than a generic model error.

Publication additionally requires `CODING_PUBLICATION_ENABLED=true` and a separately scoped
`CODING_GITHUB_WRITE_TOKEN` with contents and pull-request write permissions for allowed targets.
`CODING_GITHUB_READ_TOKEN` is separate; existing intelligence credentials do not authorize coding.
Approval is initiating-principal, content, checks, branch and PR-metadata bound, expires within
five minutes and is consumed once. Publication rechecks the base and creates only a new
`agent-ops/<job-id>` branch and **draft** PR in the same repository. It never overwrites branches,
force pushes, merges or deploys. Partial/uncertain writes require explicit `code reconcile`;
reconciliation observes the branch/PR before attempting the missing stage and does not delete
remote branches. Recovery claims durable ownership and refuses to run while the prior publisher
is active. A moved base requires a new proposal.

Mention the Discord bot with `code prepare owner/repo main <task>` (task up to 1,000 characters).
It returns a pinned target/task confirmation. Reply with `code confirm <confirmation-id>` within
five minutes; confirmation is user/channel bound, single-use and discarded on restart.
Then use `code show <job-id>`, `code approve <job-id> <digest>`, `code reject <job-id>`,
`code cancel <job-id>`, `code expire <job-id>`, `code recover <job-id>` or
`code reconcile <job-id> <digest>`.
Only platform-authenticated allowlisted human messages authorize execution/publication; the
LLM router cannot manufacture approval. Browser inspection remains read-only.

Coding execution and Discord delivery are recorded separately. A definite attachment rejection
returns a text-only result; uncertain network delivery is not automatically retried. Use
`code show <job-id>` in the same channel to retrieve the saved proposal without rerunning coding.
Delivery failures log and retain allowlisted HTTP/Discord/transport codes, never raw exceptions
or uploaded source. Look for `discord_bot.coding_delivery_failed` when troubleshooting.
Discord REST uses its own Undici dispatcher, aligned with `discord.js`'s transport version,
so loading the coding SDK cannot replace its upload transport. SDK-level REST retries are
disabled as well; ambiguous sends remain uncertain rather than silently duplicating messages.

Workers are removed after capture or failure. Restart never replays work. `code recover` marks
an interrupted preparation only after its original run has stopped, then removes only containers
labelled for that owned job. Cleanup of already failed/interrupted jobs can be retried without replay.
`code cancel` records a principal-bound cancellation request in shared
history; the preparation owner polls it and stops outstanding work, including across CLI processes.
CLI also accepts SIGINT/SIGTERM. Proposals expire after 24 hours by default (operator-configurable
down to one minute with `CODING_PROPOSAL_RETENTION_MS`); explicit `code expire`
removes unpublished private proposal/approval data and its local display artifact. Retained private
proposals are capped at 128 MiB; history size remains independently managed. SQLite deletion is
not cryptographic erasure. Expiration cleanup can be retried after a partial failure. Remote branches
and delivered Discord attachments are never deleted.

Run the containment gate after provisioning the fixture image:

```bash
docker pull node@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a
make test-coding-worker CODING_TEST_IMAGE=node@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a
```

## Usage

Run a read-only readiness sweep:

```bash
# Reads MINIMAX_API_KEY from $AGENT_OPS_HOME/.env when present.
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

## Community

Agent Ops Kit is distributed as source under the [MIT License](LICENSE); npm publication and a
global CLI installation are not supported. See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing
changes and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for participation expectations. Report
security vulnerabilities privately by following [SECURITY.md](SECURITY.md), not through a public
issue.
