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

## Live Discord Validation

For Discord-facing behavior changes, supplement automated tests with a live test
through the actual bot and configured channel when credentials and access are
available. Do not ask the user to perform routine validation that the agent can
complete itself.

1. Use the local, ignored `.env` through the existing application configuration.
   Never print or commit credentials. Use the configured allowlisted channel and
   an approved disposable repository for coding tests.
2. Check whether a bot instance is already running. Ensure the tested instance
   runs the changed code without starting a duplicate bot; do not stop an instance
   owned by another operator without approval.
3. Exercise the affected request through Discord, including a real bot mention
   when required. A direct API send can test delivery, but does not validate human
   request handling or principal-bound approval. Use the available Discord UI for
   human-only flows when authorized; never impersonate a user or bypass identity
   checks. If that access is unavailable, report the limitation and request only
   the necessary human step.
4. Verify the received reply, relevant formatting, and attachments in Discord.
   Inspect shared history to confirm execution and delivery outcomes separately;
   a completed run does not prove its reply was delivered. Check for duplicate
   execution or delivery when relevant to the change.
5. Validate affected failure paths with automated tests when they cannot be
   exercised safely live. Avoid rerunning coding work merely to test delivery;
   use saved proposal or report retrieval when appropriate.
6. Report which paths passed automated tests, which were verified live, and which
   remain untested. Include nonsecret run/message identifiers and any required
   user action, without exposing private source or raw credential-bearing logs.

Live testing is not blanket permission to approve publication, push code, open
PRs, or perform destructive external actions. Obtain explicit authorization for
those actions and preserve the application's human approval boundaries. Do not
broaden allowlists or enable publication merely to make a test pass.
