# Database

## Modeling

Use Drizzle for persisted SQLite tables. Keep table definitions under `src/db/schema.ts`.

Use TypeBox for tool input/output schemas and API-shaped data contracts. Do not duplicate schema definitions by hand when a TypeBox contract can be reused at a boundary.

## Schema Changes

Schema changes should start in the Drizzle schema, then update the local bootstrap SQL in `src/db/index.ts` until the project adopts generated migrations.

Review schema changes carefully before committing because sweep state is written into managed Agent Ops Kit state under `AGENT_OPS_HOME`.

## Local State

Readiness sweep state belongs under `AGENT_OPS_HOME`, defaulting to `~/.agent-ops-kit/`. Keep target-scoped databases and reports under `targets/<target-key>/`; do not write sweep state into the inspected source tree unless the user explicitly asks for a different artifact.
