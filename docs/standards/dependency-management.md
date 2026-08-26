# Dependency Management

## Package Manager

Use `pnpm` for dependency management and command execution. Prefer Makefile targets when they exist.

## Adding Dependencies

- Add runtime dependencies to `dependencies` in `package.json`.
- Add test, lint, typing, or development-only dependencies to `devDependencies`.
- Keep `pnpm-lock.yaml` in sync after dependency changes.
- Do not add a dependency when Node.js or an existing dependency is sufficient and clear.

## Runtime Version

The project targets Node.js 24. Keep `package.json`, CI, and local runtime assumptions aligned when that changes.
