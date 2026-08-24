# Database

## Modeling

Use SQLModel for persisted models. SQLModel models are the source of truth for
database tables and typed data access.

## Migrations

All schema changes must go through Alembic.

1. Update SQLModel models first.
2. Generate a migration with:

   ```bash
   uv run alembic revision --autogenerate -m "describe change"
   ```

3. Review the generated migration before committing it.
4. Apply it locally with:

   ```bash
   uv run alembic upgrade head
   ```

Never manually modify the database schema outside migrations.

## Local State

Readiness sweep state is local to the inspected repository and belongs under
`.agent-readiness/`. Do not write sweep state into the source tree outside that
directory unless the user explicitly asks for a different artifact.
