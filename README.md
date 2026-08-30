# Agent Ops Kit

Agent Ops Kit is a tool-centered harness for making repositories easier and safer for AI agents to inspect.

## Purpose

Make repository work inspectable, repeatable, and approval-friendly before adding higher-autonomy behavior.

The current workflow is intentionally narrow:

- accept requests through user-facing surfaces such as CLI and chat adapters
- load the readiness plugin
- expose enabled plugin sources through a small tool catalog for chat surfaces
- deterministically gather a compact evidence packet from a repository
- load the plugin's readiness interpretation skill for the LLM
- ask MiniMax to interpret the collected evidence
- write a Markdown report
- persist run metadata in a local SQLite database
- avoid source edits unless a human explicitly asks

## Setup

```bash
make install
```

## Usage

Run a read-only readiness sweep:

```bash
# Reads MINIMAX_API_KEY from .env when present.
make sweep REPO=/path/to/repo
make sweep REPO=https://github.com/org/repo REF=main
```

The sweep still records a skipped report when `MINIMAX_API_KEY` is not configured.

Run the Discord bot surface:

```bash
make discord
```

See [docs/discord.md](docs/discord.md) for bot token, allowlist, intent, and command setup.

Sweep output is written under Agent Ops Kit managed state. Override the default with
`AGENT_OPS_HOME` when you want an isolated state directory:

```text
~/.agent-ops-kit/
  cache/git/
  workspaces/
  targets/
    <target-key>/
      agent-ops.db
      reports/
```

## Project Shape

```text
src/
  db/          Drizzle schema and local SQLite persistence
  harness/     shared runtime contracts, model setup, Pi tool adapters, progress, timeouts, and usage helpers
  plugins/     domain bundles with manifests, evidence recipes, tools, and skills
  surfaces/    user-facing entry surfaces such as CLI and Discord chat adapters
  tools/       shared TypeBox tool contracts, tool registry, catalog bridge, and report helpers
  workspaces/  target normalization, managed git checkouts, and workspace leases
  workflows/   orchestration such as the readiness sweep and chat tool router
```

Evidence gathering is deterministic. Sweeps resolve a local git path or Git URL into a managed
workspace lease, inspect that checkout, record the target ref and commit, then clean up the
workspace. Local path sweeps inspect committed git state, not uncommitted working tree changes.
Plugins bundle domain-specific manifests, recipes, tools, and skills. The registry
indexes plugin tools, and the catalog exposes plugin sources to chat surfaces. Chat surfaces
enable sources such as `readiness`; Pi sees stable bridge tools like `searchTools` and
`executeTool`; workflows connect tool execution, model interpretation, persistence, and reporting.
The CLI sweep remains a direct workflow path for predictable use.

## Validation

```bash
make format
make lint
make test
make typecheck
make deadcode
make check
```
