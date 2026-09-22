# Coding Live Validation

Live validation is opt-in and separate from `make check` and CI. Credentials are not authorization. Use only a named disposable repository and an operator-allowed profile/principal. Never point this runner at a production repository by default.

## Preparation Gate

Create a private scenario JSON file outside the repository:

```json
{
  "scenario": "prepare",
  "authorization": {
    "repository": "example-org/agent-coding-fixture",
    "baseBranch": "main",
    "principal": "cli:501",
    "permittedWrites": []
  },
  "task": "Fix the incorrect cart total calculation. Keep tests and dependency inputs unchanged.",
  "limits": { "timeoutMs": 120000, "maxModelCalls": 10, "maxTokens": 20000 }
}
```

Use your actual `cli:<uid>` principal, not the example. Configure `CODING_ENABLED=true`, `CODING_ALLOWED_PRINCIPALS`, and `CODING_PROFILES` explicitly for that repository and principal. Supply a separately scoped `CODING_GITHUB_READ_TOKEN` and `MINIMAX_API_KEY`. A private target requires access granted to that read credential. This runner never substitutes ambient `gh` authentication, `GH_TOKEN`, or `GITHUB_TOKEN`.

The profile must select a locally available digest-pinned image and operator-owned required checks. For the initial service/publication proof, Node 24 can execute the fixture's TypeScript behavioral tests with `node --test src/cart.test.ts` without installing development dependencies. This is not proof of dependency-bearing TypeScript support or typechecking; that gate requires the planned prepared environment.

```sh
pnpm coding:live -- --config /private/path/scenario.json --env-file .env
# With credentials and profile already exported:
make coding-live CONFIG=/private/path/scenario.json
```

`.env` is read only when explicitly selected. Exported environment values override file values. Preparation loads only coding read/model credentials, forces publication off, and requires an empty permitted-write list. Scenario budgets can reduce operator budgets, never expand them. Wrong targets/principals, unknown fields, missing credentials, or an unwritable receipt destination refuse before external work.

## Receipts and Retained State

Each accepted scenario creates a new private temporary history home (`0700`) and receipt (`0600`). Keep the printed paths: the receipt and sealed proposal are retained there rather than added to the normal history home. No existing history or remote resource is deleted.

The bounded receipt records repository/base/image, configured model and effective budgets, interaction and preparation run/job IDs, pinned commit, proposal digest, required-check outcomes, recorded model-call/token totals, component boundaries, zero publication writes, and owned-worker cleanup. Raw HTTP errors, credentials, proposal source, model prose and check output are not receipt content. Unknown model usage remains `null`, not zero, and blocks a passed live gate. A failed or interrupted scenario is never marked passed.

The script reserves and flushes its receipt before source/model/worker work. Later storage failure stops the scenario; its pre-existing receipt can remain nonterminal. Inspect retained history before retrying. An interrupted job may require the existing `code recover` command; recovery removes owned workers but never replays agent work.

This preparation entry point does **not** grant publication. Inspect the proposal using the existing CLI with `AGENT_OPS_HOME` set to the printed private home. Publication and reconciliation require separately enabled/scoped write credentials and the existing human exact-digest approval flow. Live gateway validation requires your own human Discord messages, not bot-authored messages or automation using a normal account token.

## Selected Validation Target

The operator selected `example-org/agent-coding-fixture` and an existing `.env` Discord channel. That selection does not supply missing coding credentials, identify an authenticated human principal, or approve a sealed proposal. Do not silently broaden the channel allowlist or enable publication.

Full live publication/response-loss, human Discord, and prepared TypeScript gates must have their own completed evidence before rollout is considered complete. Deterministic tests and simulated receipts do not substitute for them.

## Offline Regression Gate

```sh
make test-coding-worker CODING_TEST_IMAGE=<locally-available-digest-pinned-node-image>
```

The worker gate includes the production Discord message-entry journey using real recording, Docker editing, immutable-source fresh verification, and shared-history proposal/approval/publication state. Model responses and Discord/GitHub transports are simulated; it never loads `.env` or calls live services. It covers identity/conversation filtering, single-use/expired/restarted confirmation, pinned-base changes, duplicates, blocked/truncated checks, active cancellation, and failed acknowledgment/attachment/PR delivery without replay.

The end-to-end suite also simulates separate successful branch and PR POST response losses. Reconciliation creates only the missing PR after a lost branch response; after a lost PR response it performs no additional write. These are regression proofs, not live GitHub evidence.
