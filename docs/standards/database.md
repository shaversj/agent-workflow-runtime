# Database

## Modeling

Use Drizzle for persisted SQLite tables. Keep shared-history definitions in `src/db/schema.ts` and
dedicated coordination-store definitions under `src/db/`.

Use [Runtime Contracts](runtime-contracts.md) for TypeBox guidance at API-shaped
boundaries and database-read projections.

## Schema Changes

Schema changes should start in the Drizzle schema, then update the local bootstrap SQL in `src/db/index.ts` until the project adopts generated migrations.

Review schema changes carefully before committing because sweep state is written into managed Agent Ops Kit state under `AGENT_OPS_HOME`.

## Local State

Shared interaction history belongs at `AGENT_OPS_HOME/history/agent-ops.db`, defaulting to
`~/.agent-ops-kit/history/agent-ops.db`. Registered artifacts belong in `history/artifacts/`.
Workspace caches and disposable checkouts are independent of history. Never write history into
the inspected source tree.

Cross-process mirror coordination belongs at `AGENT_OPS_HOME/cache/git/.mirror-locks.db`. It stores
only canonical hashed mirror identities, monotonic fencing counters, owner identity, staging
basenames, and the current immutable mirror pointer. It is not interaction history.

## Durability

Use short transactions, foreign keys, a bounded busy timeout, WAL, and FULL synchronization on a
local filesystem. Verify the runtime SQLite WAL-reset fix before enabling WAL. Keep database,
sidecars, and artifacts owner-readable/writable, and directories owner-only.

The versioned bootstrap accepts the current shared-history schema and transactionally upgrades
the supported shared-history version 1 to version 2. This is not a legacy target-database migration.
Unknown, corrupt, and newer schemas fail
explicitly. Read-only inspection must not bootstrap, migrate, recover, checkpoint, or create an
absent database. Missing state is empty, not an error suppression policy.

Interactions own messages, runs, tool/model calls, artifacts, and delivery attempts. Runs have
global integer IDs and optional parent/triggering-call links. Terminal updates are conditional
and owner-checked. Commit tool starts before execution. Do not hold transactions across external
operations. Sum usage from model-call rows rather than adding parent and child summaries.

Only a writer may recover unfinished work whose same-host process is provably absent. PID reuse,
permission failures, live processes, and foreign hosts remain unresolved. Pending deliveries may
become uncertain while completed execution stays completed. Never resume or replay work implicitly.

Mirror mutation follows the same conservative ownership rule. Hold no SQLite transaction across
Git or filesystem work. Acquire a monotonically increasing fence in a short transaction, build in
a unique fence-owned directory, and publish the current pointer only when the same token still owns
the fence. Cleanup may remove only the owner's staging path or a superseded immutable mirror after
publication. A live, foreign, permission-denied, or otherwise ambiguous owner must time out instead
of being stolen.

## Legacy Retirement

This cutover has no legacy reader, migration, backfill, or compatibility writer. Old target
databases and reports are ignored by runtime code. Stop all old CLI and Discord writers before
using the separate retirement script. Review its inventory, then explicitly apply that manifest.
Deletion is irreversible without an independently retained copy; fix forward, not by restarting
the old binary.

The script may remove only recognized `targets/<target-key>/agent-ops.db`, known SQLite sidecars,
and generated readiness reports named in the reviewed manifest. Unknown files, source-repository
`.agent-readiness` directories, credentials, caches, and the new history directory are excluded.
It must revalidate file identity and containment, reject symlinks/stale manifests/busy databases,
and report remaining files on failure. Never recursively remove whole state directories or run
cleanup automatically during install, startup, sweep, or inspection.

Use a canonical, non-symlinked managed-state root and install `lsof` so the script can verify
there are no open database handles. Preview also refuses busy or unrecognized databases.
The schema allowlist covers the frozen pre-cutover schema and its earlier version without
`run.token_count` and `run.failure_reason`. Other variants remain blocked; preview never
migrates a database to make it eligible for deletion.

```bash
pnpm --silent retire-legacy-state preview --root "$HOME/.agent-ops-kit" > /tmp/legacy-retirement.json
# Review the manifest, then stop all old writers before this irreversible step:
pnpm --silent retire-legacy-state apply --root "$HOME/.agent-ops-kit" --manifest /tmp/legacy-retirement.json --writers-stopped
```

Keep the manifest outside candidate directories. A stale or changed manifest requires a fresh
preview and review. After a partial failure, inspect `remaining` rather than assuming success.
