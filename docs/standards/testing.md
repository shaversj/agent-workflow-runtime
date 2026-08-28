# Testing

## Test Boundaries

Tests should prove behavior at the boundaries Agent Ops Kit exposes:

- CLI commands and output behavior
- workflow behavior
- tool contracts and routing
- database persistence and schema-sensitive flows
- Markdown report contents and artifact paths

Prefer tests that exercise real project objects over tests that only mock local
helper functions.

## Test Organization

- Keep tests under `tests/`.
- Name test files for the behavior or module they cover.
- Keep fixtures small and explicit.
- Use temporary directories for inspected repositories and set `AGENT_OPS_HOME`
  to a temporary directory when tests generate sweep state or reports.

## Coverage Expectations

Add or update tests when a change affects user-visible behavior, persistence,
report content, validation, or error handling.

Documentation-only, Makefile-only, and pure refactor changes may rely on manual
inspection plus existing tests when behavior is unchanged.
