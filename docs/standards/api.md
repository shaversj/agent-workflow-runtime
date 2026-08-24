# API

## FastAPI Boundary

Keep the API boundary thin. Route handlers should validate request data, call
workflow logic, and return typed responses.

Reusable behavior should live in the core modules so it can be shared by both
the CLI and API.

## Schemas

- Use explicit request and response models for API inputs and outputs.
- Keep response fields stable and simple.
- Return paths as strings at the API boundary.

## Errors

Prefer clear domain errors from workflow code and translate them at the API
boundary when needed. Do not leak stack traces, environment details, secrets, or
private file contents through API responses.
