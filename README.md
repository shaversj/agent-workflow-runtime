# Agent Ops Kit

Agent Ops Kit is a task-centered toolkit for making repositories easier and safer for AI agents to work in.

## Purpose

Make repository work more inspectable, repeatable, and approval-friendly before adding higher-autonomy agent behavior.

V1 focuses on a small, useful loop:

- inspect a repository
- identify missing agent-readiness signals
- store the run in a local SQLite database
- write a Markdown report
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

The sweep writes local output inside the inspected repository:

```text
.agent-readiness/
  agent-ops.db
  reports/
```

Start the API during development:

```bash
make dev
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
