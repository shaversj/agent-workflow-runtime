# Database

## Modeling

Use Drizzle for persisted SQLite tables. Keep table definitions under `src/db/schema.ts`.

Use TypeBox for tool input/output schemas and API-shaped data contracts. Do not duplicate schema definitions by hand when a TypeBox contract can be reused at a boundary.

## Schema Changes

Schema changes should start in the Drizzle schema, then update the local bootstrap SQL in `src/db/index.ts` until the project adopts generated migrations.

Review schema changes carefully before committing because sweep state is written into inspected repositories under `.agent-readiness/agent-ops.db`.

## Local State

Readiness sweep state is local to the inspected repository and belongs under `.agent-readiness/`. Do not write sweep state into the source tree outside that directory unless the user explicitly asks for a different artifact.
