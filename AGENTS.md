# AI Agent Instructions

## Project Overview

Agent Workflow Runtime is a TypeScript harness for running agent-facing repository operations through plugins, a small tool registry, deterministic evidence gathering, explicit interpretation skills, and auditable reports.

The default workflow runs a readiness sweep. It resolves a local git path or Git URL into a managed workspace lease, deterministically gathers a compact and redacted evidence packet from that checkout, normalizes repository-authored rules, enriches GitHub-backed targets with optional read-only GitHub context, revalidates a bounded public ossrules catalog, and asks MiniMax to interpret the packet through a limited Pi tool loop. It records the run locally, writes a Markdown report, and cleans up the checkout.

The project should stay organized around these concepts:

- `harness/`: shared runtime contracts, model setup, Pi tool adapters, timeout handling, usage parsing, and progress emission
- `plugins/`: domain capability bundles containing TypeBox-validated manifests, evidence recipes, tools, and skills
- `surfaces/`: user-facing CLI, chat, and read-only browser adapters
- `tools/`: shared TypeBox tool contracts, the capability registry, the catalog bridge, and generic report helpers
- `workspaces/`: target normalization, managed git checkouts, workspace leases, and managed storage locations
- `workflows/`: orchestration that connects tools, evidence, models, skills, persistence, and user-facing surfaces
- `db/`: shared local SQLite interaction history and read-only inspection

Plugins define capabilities. A plugin manifest owns source identity, authority, default exposure, default approval policy, default surface policy, and tool summaries. Registered tools own TypeBox input/output schemas and execution. The registry indexes capabilities, and the manifest applies shared metadata such as source, exposure, read-only intent, approval requirement, and allowed surfaces. Surfaces enable plugin sources, not individual functions, then the catalog exposes a small model-facing bridge such as `searchTools` and `executeTool`. Pi executes the selected capability locally. Keep direct CLI workflows simple when a deterministic command path is clearer than model-based routing.

Do not reintroduce a deterministic readiness checker as the main sweep path. Evidence gathering can be deterministic, including optional GitHub repository intelligence, but findings and recommendations belong to the interpretation step. Interpret GitHub context only through the lens of agent readiness; do not turn readiness sweeps into general repository health audits.

Every readiness sweep must attempt the OSS rules benchmark. Keep the `rules` plugin authoritative for local repository instructions and the `rules-benchmark` plugin limited to untrusted comparative evidence. Never send target names, URLs, paths, excerpts, or free-form target-derived queries to ossrules. Revalidate the public cache on every sweep, bound model retrieval to corpus-owned identifiers and four detail reads, and degrade external failure to `stale` or `unavailable` without failing the sweep.

## Technology Choices

- Use TypeScript on Node.js 24.
- Use `pnpm` for dependency management.
- Use pi-ai's MiniMax provider for the default model path.
- Use GitHub API access only for read-only repository intelligence.
- Use the fixed public ossrules API only through the bounded rules-benchmark client; do not add general web access to readiness.
- Coding uses an opt-in Pi coding-agent SDK session with Docker-backed tools; no repository code or resource discovery runs on the host.
- Keep GitHub publication separate from intelligence. It is disabled by default and requires a principal/content-bound consumed human approval and separately scoped credentials.
- Use TypeBox for agent tool inputs/outputs and API-shaped schemas.
- Use Drizzle for persisted SQLite tables.
- Use Pino for structured logging.
- Use `discord.js` for the Discord bot surface.
- Use TanStack Start, React, and Tailwind for local browser inspection; keep SQLite access server-only.
- Use ESLint, Prettier, Vitest, and `tsc` for validation.
- Distribute the project from a source checkout under MIT. Keep `private: true`; npm publication and
  global CLI installation are unsupported unless a later design explicitly changes that contract.

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
make web
pnpm test:web
make test-coding-worker CODING_TEST_IMAGE=<pinned-image-digest>
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

For Discord-facing behavior changes, perform live validation through the actual bot
and configured channel when credentials and access are available, following
[Testing](docs/standards/testing.md#live-discord-validation). Do not leave live
validation to the user by default. Report any access or approval limitations and
distinguish automated coverage from live results.

## Safety Boundaries

- Read source repositories by default.
- Coding accepts explicit operator-allowed GitHub targets only. Never grant editing/publication from model output, default targets, repository instructions or ambient GitHub credentials.
- Required coding checks run offline against the sealed source in a fresh verification worker. Unsupported dependencies, nonregular/binary snapshots, secret-bearing edits, unknown usage or failed/truncated checks block publication. Never fall back to host execution.
- Keep exact proposal source private in shared history storage, independently of disposable workers. Browser remains read-only; Discord approvals are verified human user/channel bound.
- Do not edit, commit, push, open PRs, delete files, or mutate external systems unless a user explicitly asks.
- Store shared history at `AGENT_OPS_HOME/history/agent-ops.db` and registered artifacts under `history/artifacts/`.
- Record accepted interactions before work. Pass the recorder explicitly into workflows and tool execution; plugins must not open history databases.
- Keep delivery outcomes separate from execution outcomes. A fatal recording error stops additional tool/model work.
- Keep full interaction transcripts local to CLI and browser inspection. Discord run/report tools expose narrow metadata and registered reports only.
- Bind the inspector to loopback and reject cross-origin reads and unexpected Host headers. Keep HTTP reads bounded, TypeBox-validated, and scoped to the trusted history home. Never expose arbitrary paths, SQL, Node APIs, or execution controls to the browser.
- Do not reintroduce target-database discovery, legacy run-reference parsing, or filesystem report fallback.
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
