# Agent Ops Kit

Agent Ops Kit is a tool-centered harness for making repositories easier and safer for AI agents to inspect.

## Purpose

Make repository work inspectable, repeatable, and approval-friendly before adding higher-autonomy behavior.

The current workflow is intentionally narrow:

- run a pi-agent-core workflow against a repository
- expose only explicit read-only tools for repo inspection
- load a readiness sweep skill for interpretation
- write a Markdown report through a report-submission tool
- persist run metadata in a local SQLite database
- avoid source edits unless a human explicitly asks

## Setup

```bash
make install
```

## Usage

Run a read-only readiness sweep:

```bash
export MINIMAX_API_KEY=...
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
  skills/      workflow prompts and durable agent instructions
  tools/       TypeBox tool contracts and pi-agent-core adapters
  workflows/   orchestration such as the readiness sweep
```

Tools are small TypeBox contracts with handlers. Skills are prompts. Workflows connect a model, skill, tools, persistence, and reporting.

## Validation

```bash
make format
make lint
make test
make typecheck
make check
```
