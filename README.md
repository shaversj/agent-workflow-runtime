# Agent Ops Kit

Agent Ops Kit is a tool-centered harness for making repositories easier and safer for AI agents to inspect.

## Purpose

Make repository work inspectable, repeatable, and approval-friendly before adding higher-autonomy behavior.

The current workflow is intentionally narrow:

- load the readiness plugin
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
```

The sweep still records a skipped report when `MINIMAX_API_KEY` is not configured.

Sweep output is written inside the inspected repository:

```text
.agent-readiness/
  agent-ops.db
  reports/
```

## Project Shape

```text
src/
  db/          Drizzle schema and local SQLite persistence
  plugins/     domain bundles with manifests, evidence recipes, tools, and skills
  tools/       shared TypeBox tool contracts and report helpers
  workflows/   orchestration such as the readiness sweep
```

Evidence gathering is deterministic. Plugins bundle domain-specific manifests, recipes, tools, and skills. Workflows connect plugins, model interpretation, persistence, and reporting.

## Validation

```bash
make format
make lint
make test
make typecheck
make check
```
