# Testing

## Test Boundaries

Tests should prove behavior at the boundaries Agent Ops Kit exposes:

- CLI commands and output behavior
- readiness check classification
- harness tool contracts and routing
- database persistence and migration-sensitive flows
- Markdown report contents and artifact paths

Prefer tests that exercise real project objects over tests that only mock local
helper functions.

## Test Organization

- Keep tests under `tests/`.
- Name test files for the behavior or module they cover.
- Keep fixtures small and explicit.
- Use temporary directories for inspected repositories and generated
  `.agent-readiness/` output.

## Coverage Expectations

Add or update tests when a change affects user-visible behavior, persistence,
report content, validation, or error handling.

Documentation-only, Makefile-only, and pure refactor changes may rely on manual
inspection plus existing tests when behavior is unchanged.
