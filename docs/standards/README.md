# Standards

These standards are the durable working rules for Agent Ops Kit. Keep `AGENTS.md`
short and directive, then put detailed guidance here.

Consult the relevant standard before changing the related surface:

- [Development Workflow](development-workflow.md) - setup, common commands, validation order
- [Dependency Management](dependency-management.md) - `uv`, Python versions, lockfile handling
- [Testing](testing.md) - test organization, coverage expectations, verification evidence
- [Database](database.md) - SQLModel, Alembic, SQLite state, migration review
- [API](api.md) - FastAPI boundary, request/response schemas, error handling
- [CLI and Reports](cli-and-reports.md) - Typer commands, local output, report behavior
- [Logging](logging.md) - structlog events, levels, context, privacy
- [Security and Privacy](security-and-privacy.md) - read-only defaults, secret handling, safe artifacts

Add a new standard only when the repo grows a durable surface that future work
will repeatedly touch. Prefer updating an existing standard over creating a
near-duplicate page.
