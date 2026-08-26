# AI Agent Instructions

## Project Overview

Agent Ops Kit is a TypeScript harness for running agent-facing repository operations through deterministic collection, explicit skills, and auditable reports.

The default workflow runs a readiness sweep. It deterministically collects a compact, redacted evidence packet, loads a readiness interpretation skill, asks MiniMax to interpret the packet, records the run locally, and writes a Markdown report.

The project should stay organized around four concepts:

- `collection/`: deterministic, secret-safe evidence collection
- `skills/`: durable prompts and instructions for agent behavior
- `tools/`: low-level TypeBox contracts and report helpers
- `workflows/`: orchestration that connects collection, models, skills, persistence, and CLI commands

Do not reintroduce a deterministic readiness checker as the main sweep path. Collection can be deterministic, but findings and recommendations belong to the interpretation step.

## Technology Choices

- Use TypeScript on Node.js 24.
- Use `pnpm` for dependency management.
- Use pi-ai's MiniMax provider for the default model path.
- Use TypeBox for agent tool inputs/outputs and API-shaped schemas.
- Use Drizzle for persisted SQLite tables.
- Use Pino for structured logging.
- Use ESLint, Prettier, Vitest, and `tsc` for validation.

## Environment Setup

- Use `pnpm` for dependency management and script execution.
- Prefer Makefile commands when available.
- Run `make install` before running checks in a fresh clone, new worktree, or recreated environment.

## Common Commands

```bash
make install
make format
make lint
make test
make typecheck
make check
make sweep REPO=/path/to/repo
```

## Development Workflow

1. Bootstrap the environment with `make install`.
2. Keep changes scoped to tools, skills, workflows, or persistence as appropriate.
3. Add future deterministic collection behavior under `src/collection/` and keep collection recipes in `src/skills/`.
4. Add future tools as separate files under `src/tools/` only when a workflow needs an explicit callable tool surface.
5. Run focused validation for the touched surface.
6. Run `make check` before handoff when behavior changed.
7. Update `README.md` and `AGENTS.md` when installation, commands, project structure, workflow, or user-facing behavior changes.

## Safety Boundaries

- Read source repositories by default.
- Do not edit, commit, push, open PRs, delete files, or mutate external systems unless a user explicitly asks.
- Store local sweep output under `.agent-readiness/` in the inspected repo.
- Keep secret values out of reports, logs, fixtures, and tests.
- Redact secret-shaped values before evidence is sent to an LLM.
- Skip known sensitive files such as `.env`, credentials files, private keys, and local package auth files during collection.

## Standards Reference

Consult these standards when making changes:

- [Standards Index](docs/standards/README.md)
- [Development Workflow](docs/standards/development-workflow.md)
- [Dependency Management](docs/standards/dependency-management.md)
- [Formatting](docs/standards/formatting.md)
- [Testing](docs/standards/testing.md)
- [Database](docs/standards/database.md)
- [CLI and Reports](docs/standards/cli-and-reports.md)
- [Logging](docs/standards/logging.md)
- [Static Analysis](docs/standards/static-analysis.md)
- [Security and Privacy](docs/standards/security-and-privacy.md)

## Additional Context

Read and load `AGENTS.local.md` if it exists for local-only instructions. Do not commit local-only instruction files unless the user explicitly asks.
