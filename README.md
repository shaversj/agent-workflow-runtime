# Agent Ops Kit

Agent Ops Kit is a task-centered toolkit for making repositories easier and safer for AI agents to work in.

## Purpose

Make repository work more inspectable, repeatable, and approval-friendly before adding higher-autonomy agent behavior.

V1 focuses on a small, useful loop:

- inspect a repository
- identify missing agent-readiness signals
- store the run in a local SQLite database
- write a Markdown report
- run a mini-swe-agent harness that can call the sweep as a tool
- avoid source edits unless a human explicitly asks

## Setup

```bash
make install
```

## Usage

Run a read-only readiness sweep:

```bash
make sweep REPO=/path/to/repo
```

By default, the sweep uses the mini-swe-agent harness with MiniMax:

```bash
export MINIMAX_API_KEY=...
make sweep REPO=/path/to/repo
```

Harness output is appended to the Markdown report after deterministic findings, passed signals, and informational standards notices. The harness exposes the deterministic sweep as a read-only `agent_ops_sweep` tool and asks MiniMax to reason over only that evidence. The sweep still completes without an API key; the report records the harness as skipped.

Harness tool families live in `src/agent_ops_kit/harness_tools/` and are loaded by profile. Each tool declares its schema, permissions, examples, and handler. The mini-swe-agent adapter lives in `src/agent_ops_kit/harness.py`, and generic harness result handling lives in `src/agent_ops_kit/harness_result.py`.

The sweep writes local output inside the inspected repository:

```text
.agent-readiness/
  agent-ops.db
  reports/
```

## Validation

```bash
make format
make check
```

## Database Migrations

All schema changes go through Alembic.

1. Update the SQLModel models in `src/agent_ops_kit/models.py`.
2. Generate a migration:

   ```bash
   uv run alembic revision --autogenerate -m "describe change"
   ```

3. Review the generated migration.
4. Apply it:

   ```bash
   uv run alembic upgrade head
   ```

Never manually modify the database schema outside of migrations.
