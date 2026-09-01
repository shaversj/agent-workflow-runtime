# Runtime Contracts

## Boundary Validation

Use TypeBox at runtime trust boundaries.

External, model, plugin, CLI, Discord, durable-state, database-read projection, and
tool contracts must have one owning TypeBox schema when the application treats the
value as a typed contract.

Boundary parsers should accept `unknown` and return parsed TypeScript types derived
from the owning schema. After validation, internal runtime code should use parsed
types and should not repeat ad hoc object-shape checks for the same value.

## Tool Contracts

Define tool inputs and outputs with TypeBox.

Validate tool inputs before invoking plugin code. Validate the full tool result
envelope before returning to the caller:

- `result`
- `text`
- `terminate`

Validate the nested `result` payload with the tool's declared `resultSchema`.

## Workflow Contracts

Define workflow results with TypeBox.

Use the workflow result schema when reading model or tool details that may represent
a workflow result. Incomplete or invalid workflow-like details should be treated as
ordinary tool output unless the caller explicitly requires a workflow result.

## Manual Narrowing

Manual `typeof`, `Array.isArray`, and `in` checks are allowed when parsing adapter
data, narrowing unions, extracting optional fields, or handling provider-owned
shapes without a local schema.

Do not use manual object-shape checks when an equivalent TypeBox schema already
exists.

## Database Boundary

Use Drizzle for persisted table definitions.

Use TypeBox for data once it crosses into tool results, report inspection results,
workflow results, plugin manifests, or other API-shaped contracts.
