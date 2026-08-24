# Dependency Management

## Package Manager

Use `uv` for Python dependency management and command execution. Prefer Makefile
targets when they exist.

## Adding Dependencies

- Add runtime dependencies to `[project].dependencies` in `pyproject.toml`.
- Add test, lint, typing, or development-only dependencies to
  `[dependency-groups].dev`.
- Keep `uv.lock` in sync after dependency changes.
- Do not add a dependency when the standard library or an existing dependency is
  sufficient and clear.

## Python Version

The project currently targets Python 3.13. Keep `requires-python`,
`tool.mypy.python_version`, and local runtime assumptions aligned when that
changes.
