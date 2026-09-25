# Coding Workflow

Coding is an opt-in capability separate from read-only sweeps. It uses Pi's coding-agent SDK with worker-backed tools and never executes repository code on the host.

## Requirements

- Docker Desktop, or a dedicated Linux Docker runtime with built-in seccomp
- A trusted, digest-pinned image containing Node and the repository's required dependencies
- An operator-owned environment file and repository profile
- Explicitly allowlisted principals and repositories

Do not use the container backend for hostile multi-tenant hosting. Network access and implicit dependency downloads are disabled.

Configure `$AGENT_OPS_HOME/.env` from the coding section of `.env.example`, or set `AGENT_OPS_ENV_FILE` to an absolute operator-owned file. Agent Workflow Runtime does not load runtime configuration from a process working directory or Git checkout. The file and its parent directory must be owned by the current user and not writable by other users.

Repository profiles specify the digest-pinned image, required verification commands, ignored generated directories, and allowed principal. Profiles are operator configuration; repository content and model output cannot change them.

## CLI Flow

```bash
pnpm exec tsx src/cli.ts code prepare example/example-repository main "Fix the addition bug"
pnpm exec tsx src/cli.ts code show <job-id>
pnpm exec tsx src/cli.ts code show <job-id> --json
pnpm exec tsx src/cli.ts code approve <job-id> --digest <64-hex-digest>
pnpm exec tsx src/cli.ts code reject <job-id>
pnpm exec tsx src/cli.ts code cancel <job-id>
pnpm exec tsx src/cli.ts code recover <job-id>
pnpm exec tsx src/cli.ts code expire <job-id>
pnpm exec tsx src/cli.ts code reconcile <job-id> --digest <64-hex-digest>
```

Approval requires an interactive terminal and the exact proposal digest. Preparation pins the base commit, creates an offline non-root worker, records model and tool activity, exports regular UTF-8 files, and runs operator-required checks in a fresh worker against root-owned read-only source. Checks can write temporary data only under `/tmp`; profiles that require source-tree build output are unsupported.

## Worker Boundaries

The coding SDK and file tools use `/workspace`. The model receives operator-configured checks, but repository guidance cannot authorize dependency installation or replace fresh-worker verification.

Preparation stops or blocks publication for symlinks, submodules, binary changes, oversized snapshots, secret-bearing changes, unknown model usage, unavailable dependencies, or failed and truncated checks. The root filesystem, capabilities, network, memory, CPU, process count, command output, and deadlines are bounded.

Default limits are:

- 20-minute workflow deadline
- 30 model calls
- 100,000 aggregate observed tokens
- 128 tool calls
- 2-minute command deadline
- 64 KiB command output
- 2 CPUs, 2 GiB memory, and 128 processes
- 200 changed files and 10 MiB changed content

Exact private proposals remain in SQLite. A bounded, redacted Markdown artifact is registered for history and browser inspection.

## Publication Boundary

The GitHub plugin owns publication and reconciliation, but those operations are hidden from model
discovery. Trusted CLI and Discord command paths may invoke them only with exact harness-minted
authority bound to the principal, surface, repository, and tool arguments. The coding capability
continues to own proposal creation, verification, lifecycle state, and human approval; preparing a
proposal does not authorize publication.

Publication requires all of the following:

- `CODING_PUBLICATION_ENABLED=true`
- a separately scoped `CODING_GITHUB_WRITE_TOKEN`
- contents and pull-request write permission for the allowed target
- a current principal-bound approval for the exact content, checks, branch, and pull-request metadata

`CODING_GITHUB_READ_TOKEN` is separate; read-only repository intelligence credentials do not authorize coding publication.

Publication creates only a new `agent-ops/<job-id>` branch and draft pull request in the same repository. It never overwrites branches, force-pushes, merges, or deploys. Approval expires after five minutes and is consumed once. A moved base requires a new proposal.

Partial or uncertain writes require `code reconcile`. Reconciliation observes the branch and pull request before attempting a missing stage, and it does not delete remote branches. Recovery claims durable ownership and refuses to proceed while the prior publisher may still be active.

## Discord Flow

Mention the bot with:

```text
code prepare example/example-repository main Fix the addition bug
```

The bot returns a pinned target and task confirmation. Reply with `code confirm <confirmation-id>` within five minutes. Confirmation is bound to the initiating user and channel, is single-use, and is discarded on restart.

After preparation, use `code show`, `code approve`, `code reject`, `code cancel`, `code expire`, `code recover`, or `code reconcile`. Only platform-authenticated, allowlisted human messages can authorize execution or publication. The LLM router cannot manufacture approval, and the browser inspector remains read-only.

Coding execution and Discord delivery are recorded separately. Definite attachment rejection falls back to text; ambiguous delivery is not automatically retried. `code show <job-id>` retrieves the saved proposal without rerunning coding.

## Cancellation And Retention

Workers are removed after capture or failure. Restart does not replay work. Cancellation is principal-bound and durable across CLI processes; SIGINT and SIGTERM are also supported.

Proposals expire after 24 hours by default. `CODING_PROPOSAL_RETENTION_MS` can reduce that window to a minimum of one minute. `code expire` removes unpublished proposal and approval data plus its local display artifact. Retained private proposals are capped at 128 MiB. SQLite deletion is not cryptographic erasure, and delivered Discord attachments or remote branches are never deleted.

## Containment Gate

Run the containment gate after provisioning the fixture image:

```bash
docker pull node@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a
make test-coding-worker CODING_TEST_IMAGE=node@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a
```
