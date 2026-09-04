# AI Agent Instructions

## Project Overview

Agent Ops Kit is a TypeScript harness for running agent-facing repository operations through plugins, a small tool registry, deterministic evidence gathering, explicit interpretation skills, and auditable reports.

The default workflow runs a readiness sweep. It resolves a local git path or Git URL into a managed workspace lease, deterministically gathers a compact and redacted evidence packet from that checkout, enriches GitHub-backed targets with optional read-only GitHub context, loads the plugin's interpretation skill, asks MiniMax to interpret the packet, records the run locally, writes a Markdown report, and cleans up the checkout.

The project should stay organized around six concepts:

- `harness/`: shared runtime contracts, model setup, Pi tool adapters, timeout handling, usage parsing, and progress emission
- `plugins/`: domain capability bundles containing TypeBox-validated manifests, evidence recipes, tools, and skills
- `surfaces/`: user-facing ways to interact with the harness, such as CLI and chat adapters
- `tools/`: shared TypeBox tool contracts, the capability registry, the catalog bridge, and generic report helpers
- `workspaces/`: target normalization, managed git checkouts, workspace leases, and target-scoped state paths
- `workflows/`: orchestration that connects tools, evidence, models, skills, persistence, and user-facing surfaces
- `db/`: local SQLite persistence for workflow runs and artifacts

Plugins define capabilities. A plugin manifest owns source identity, authority, default exposure, default approval policy, default surface policy, and tool summaries. Registered tools own TypeBox input/output schemas and execution. The registry indexes capabilities, and the manifest applies shared metadata such as source, exposure, read-only intent, approval requirement, and allowed surfaces. Surfaces enable plugin sources, not individual functions, then the catalog exposes a small model-facing bridge such as `searchTools` and `executeTool`. Pi executes the selected capability locally. Keep direct CLI workflows simple when a deterministic command path is clearer than model-based routing.

Do not reintroduce a deterministic readiness checker as the main sweep path. Evidence gathering can be deterministic, including optional GitHub repository intelligence, but findings and recommendations belong to the interpretation step. Interpret GitHub context only through the lens of agent readiness; do not turn readiness sweeps into general repository health audits.

## Technology Choices

- Use TypeScript on Node.js 24.
- Use `pnpm` for dependency management.
- Use pi-ai's MiniMax provider for the default model path.
- Use GitHub API access only for read-only repository intelligence.
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
make sweep REPO=https://github.com/org/repo REF=main
make discord
```

Set `GITHUB_TOKEN` or `GH_TOKEN` only when private repository context or higher GitHub API limits are needed.

## Development Workflow

1. Bootstrap the environment with `make install`.
2. Keep changes scoped to harness runtime, plugins, surfaces, shared tools, workflows, or persistence as appropriate.
3. Add future domain behavior under `src/plugins/<domain>/` with a TypeBox-validated manifest first, then evidence recipes, TypeBox-backed tools, and skills as needed.
4. Add user-facing interaction behavior under `src/surfaces/<surface>/`, keeping platform-specific formatting and identifiers at the edge.
5. Register plugin tools through `src/tools/registry.ts`; use source metadata and deferred exposure when a chat surface should discover tools through the catalog bridge.
6. Run focused validation for the touched surface.
7. Run `make check` before handoff when behavior changed.
8. Update `README.md` and `AGENTS.md` when installation, commands, project structure, workflow, or user-facing behavior changes.

## Safety Boundaries

- Read source repositories by default.
- Do not edit, commit, push, open PRs, delete files, or mutate external systems unless a user explicitly asks.
- Store sweep output under Agent Ops Kit managed state, defaulting to `~/.agent-ops-kit/targets/<target-key>/`.
- Inspect repositories through managed git workspaces so reports can identify the origin, ref, and commit SHA.
- Keep secret values out of reports, logs, fixtures, and tests.
- Redact secret-shaped values before evidence is sent to an LLM.
- Keep raw Git credentials inside clone/fetch operations only; logs, reports, database metadata, and tool output must use sanitized display identities.
- Skip known sensitive files such as `.env`, credentials files, private keys, and local package auth files during evidence gathering.

## Standards Reference

Consult these standards when making changes:

- [Standards Index](docs/standards/README.md)
- [Development Workflow](docs/standards/development-workflow.md)
- [Dependency Management](docs/standards/dependency-management.md)
- [Formatting](docs/standards/formatting.md)
- [Testing](docs/standards/testing.md)
- [Runtime Contracts](docs/standards/runtime-contracts.md)
- [Database](docs/standards/database.md)
- [CLI and Reports](docs/standards/cli-and-reports.md)
- [Logging](docs/standards/logging.md)
- [Static Analysis](docs/standards/static-analysis.md)
- [Security and Privacy](docs/standards/security-and-privacy.md)

## Additional Context

Read and load `AGENTS.local.md` if it exists for local-only instructions. Do not commit local-only instruction files unless the user explicitly asks.
