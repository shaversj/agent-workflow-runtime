# AI Agent Instructions

## Project Overview

Agent Ops Kit is a TypeScript harness for running agent-facing repository operations through explicit, auditable tools.

The default workflow runs a pi-agent-core readiness sweep. It loads a skill prompt, exposes registered TypeBox tools for repository inspection and report submission, records the run locally, and writes a Markdown report.

The project should stay organized around three concepts:

- `tools/`: low-level capabilities with TypeBox input/output contracts
- `skills/`: durable prompts and instructions for agent behavior
- `workflows/`: orchestration that connects models, skills, tools, persistence, and CLI commands

Do not reintroduce a deterministic readiness checker as the main sweep path. The sweep is an interpretation workflow that uses tools directly.

## Technology Choices

- Use TypeScript on Node.js 24.
- Use `pnpm` for dependency management.
- Use pi-agent-core for harness execution.
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
3. Add future tools as separate files under `src/tools/`, then register them in `src/tools/index.ts`.
4. Run focused validation for the touched surface.
5. Run `make check` before handoff when behavior changed.
6. Update `README.md` when installation, commands, project structure, workflow, or user-facing behavior changes.

## Safety Boundaries

- Read source repositories by default.
- Do not edit, commit, push, open PRs, delete files, or mutate external systems unless a user explicitly asks.
- Store local sweep output under `.agent-readiness/` in the inspected repo.
- Keep secret values out of reports, logs, fixtures, and tests.

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
