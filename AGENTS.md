# AI Agent Instructions

## Project Overview

Agent Ops Kit is a TypeScript harness for running agent-facing repository operations through plugins, deterministic evidence gathering, explicit interpretation skills, and auditable reports.

The default workflow runs a readiness sweep. It loads the readiness plugin, deterministically gathers a compact and redacted evidence packet, loads the plugin's interpretation skill, asks MiniMax to interpret the packet, records the run locally, and writes a Markdown report.

The project should stay organized around six concepts:

- `harness/`: shared runtime contracts, model setup, timeout handling, usage parsing, and progress emission
- `plugins/`: domain capability bundles containing manifests, evidence recipes, tools, and skills
- `surfaces/`: user-facing ways to interact with the harness, such as CLI and chat adapters
- `tools/`: shared TypeBox tool contracts and generic report helpers
- `workflows/`: orchestration that connects evidence, models, skills, persistence, and user-facing surfaces
- `db/`: local SQLite persistence for workflow runs and artifacts

Do not reintroduce a deterministic readiness checker as the main sweep path. Evidence gathering can be deterministic, but findings and recommendations belong to the interpretation step.

## Technology Choices

- Use TypeScript on Node.js 24.
- Use `pnpm` for dependency management.
- Use pi-ai's MiniMax provider for the default model path.
- Use TypeBox for agent tool inputs/outputs and API-shaped schemas.
- Use Drizzle for persisted SQLite tables.
- Use Pino for structured logging.
- Use `discord.js` for the Discord bot surface.
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
make discord
```

## Development Workflow

1. Bootstrap the environment with `make install`.
2. Keep changes scoped to harness runtime, plugins, surfaces, shared tools, workflows, or persistence as appropriate.
3. Add future domain behavior under `src/plugins/<domain>/` with a manifest first, then evidence recipes, tools, and skills as needed.
4. Add user-facing interaction behavior under `src/surfaces/<surface>/`, keeping platform-specific formatting and identifiers at the edge.
5. Add shared tool contracts under `src/tools/` only when multiple plugins or workflows need the same callable surface.
6. Run focused validation for the touched surface.
7. Run `make check` before handoff when behavior changed.
8. Update `README.md` and `AGENTS.md` when installation, commands, project structure, workflow, or user-facing behavior changes.

## Safety Boundaries

- Read source repositories by default.
- Do not edit, commit, push, open PRs, delete files, or mutate external systems unless a user explicitly asks.
- Store local sweep output under `.agent-readiness/` in the inspected repo.
- Keep secret values out of reports, logs, fixtures, and tests.
- Redact secret-shaped values before evidence is sent to an LLM.
- Skip known sensitive files such as `.env`, credentials files, private keys, and local package auth files during evidence gathering.

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
