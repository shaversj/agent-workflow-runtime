# Static Analysis

## Tools

Use TypeScript compiler checks for type safety, ESLint for code-quality rules, and Knip for unused files, exports, and dependencies.

Semgrep is the preferred future static-analysis tool for security or policy checks when the project has rules worth enforcing.

## Commands

```bash
make typecheck
make lint
make deadcode
```

Keep `make check` focused on the default quality gate. Add heavier static-analysis commands to `make check` only when they are stable enough for every push and pull request.
