# Formatting

## Tools

Use Prettier for formatting TypeScript, JSON, Markdown, YAML, and other supported text files.

Use ESLint for code-quality linting and `tsc` for typechecking. Do not use ESLint as a substitute for TypeScript's compiler.

## Commands

Prefer Makefile targets:

```bash
make format
make lint
make typecheck
```

`make check` must remain the required local and CI gate.

## Style

Let Prettier decide layout. Avoid manual alignment or formatting exceptions unless readability clearly improves and the formatter supports it.
