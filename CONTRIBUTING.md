# Contributing

## Set Up

Agent Workflow Runtime supports Node.js 24 and pnpm 10. Work from a source checkout:

```bash
make install
make check
pnpm test:web
```

Docker is required only for the real coding-worker containment suite. The required image and command
are documented in [Coding workflow and containment](docs/coding.md).

## Project Layout

```text
src/
  db/          Drizzle schema and local SQLite persistence
  harness/     model runtime, execution contracts, progress, and usage
  plugins/     domain manifests, tools, evidence recipes, and skills
  surfaces/    CLI, Discord, and local TanStack Start inspection
  tools/       TypeBox tool contracts, registry, and catalog bridge
  workspaces/  target normalization, Git mirrors, and workspace leases
  workflows/   orchestration for sweeps, chat routing, and coding
```

## Development Commands

```bash
make format
make lint
make test
make typecheck
make deadcode
make check

pnpm exec playwright install chromium
pnpm test:web
```

Use `make test-coding-worker CODING_TEST_IMAGE=<pinned-image-digest>` for the Docker-backed coding-worker containment suite.

## Make A Change

- Read `AGENTS.md` and the relevant file in `docs/standards/` first.
- Keep changes within the existing plugin, surface, workflow, workspace, or persistence boundary.
- Add focused tests for changed behavior and run `make check` before opening a pull request.
- Update documentation when commands, configuration, architecture, or user-visible behavior changes.
- Never commit credentials, private repository content, generated local history, or `.env` files.

Pull requests should explain the user-visible outcome, trust-boundary impact, verification performed,
and any remaining operational step. Use GitHub's private vulnerability reporting instead of a pull
request for security-sensitive findings.

This repository is source-distributed. Do not add npm publication or global installation claims
without an explicit package-distribution design.

The `agent-ops` CLI name, `AGENT_OPS_*` environment variables, and `~/.agent-ops-kit` state directory are stable compatibility identifiers retained from the project's former name.
