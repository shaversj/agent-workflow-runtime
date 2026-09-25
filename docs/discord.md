# Discord Bot

Agent Workflow Runtime can run readiness and repository intelligence tools from authorized Discord
mentions. Direct messages are intentionally unsupported.

## Environment

Put bot configuration in `$AGENT_OPS_HOME/.env` (default:
`~/.agent-ops-kit/.env`), or set `AGENT_OPS_ENV_FILE` to an absolute operator-owned file before
startup. The bot never loads `.env` from its process working directory or any Git checkout. The file
and its parent directory must be owned by the current user and not writable by other users.
The `AGENT_OPS_*` names and `~/.agent-ops-kit` path remain stable compatibility identifiers.

```bash
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_USER_IDS=
DISCORD_ALLOWED_GUILD_IDS=
DISCORD_ALLOWED_CHANNEL_IDS=
DISCORD_LOCAL_REPO_USER_IDS=
DISCORD_DEFAULT_REPO_PATH=https://github.com/org/repo
DISCORD_DEFAULT_MODEL=MiniMax-M3
DISCORD_TIMEOUT_MS=120000
DISCORD_SHUTDOWN_GRACE_MS=10000
DISCORD_ENABLED_PLUGIN_SOURCES=readiness,github
DISCORD_ALLOW_DMS=false
MINIMAX_API_KEY=
GITHUB_TOKEN=
```

`DISCORD_BOT_TOKEN` and a nonempty `DISCORD_ALLOWED_USER_IDS` are required. At least one of
`DISCORD_ALLOWED_GUILD_IDS` or `DISCORD_ALLOWED_CHANNEL_IDS` must also be nonempty. The values are
comma-separated immutable numeric Discord IDs. When both guild and channel restrictions are set,
both must match. The bot refuses to start when this policy is missing or malformed.

Direct messages, bot-authored messages, and webhook-authored messages are always rejected before
history, model, tool, Git, or network work begins. `DISCORD_ALLOW_DMS=true` is rejected at startup.

An explicit repository in chat must be a credential-free `https://github.com/...` URL. Local
paths, other schemes or hosts, IP literals, ports, redirects, queries, and fragments are rejected.
The authenticated request target is authoritative; a model-generated tool argument cannot replace
it.

`DISCORD_DEFAULT_REPO_PATH` may be a trusted operator-configured GitHub URL. It may also be a local
path, but only users listed in both `DISCORD_ALLOWED_USER_IDS` and
`DISCORD_LOCAL_REPO_USER_IDS` can use that local default. Chat messages can never select a local
path directly.

`DISCORD_ENABLED_PLUGIN_SOURCES` controls which plugin sources Discord can expose to the
chat-agent workflow. It defaults to `readiness,github`. Source selection stays at the plugin
family level; individual tools carry metadata such as source, exposure, read-only intent,
approval requirement, and allowed surfaces.

`GITHUB_TOKEN` or `GH_TOKEN` is optional. Set one when the bot needs private GitHub repository
context or higher API limits for a configured repository target. Explicit GitHub URLs supplied in
chat are queried without the bot's ambient GitHub token unless a future trusted-target policy
allows them.

## Discord App Settings

Enable these gateway intents for the bot:

- Message Content Intent is required for natural-language requests.
- Server Members Intent is not required.
- The bot needs permission to read messages and send replies in the allowed channels.

## Run

```bash
make discord
```

The bot responds when an allowed user mentions it in an allowed guild channel:

```text
@agent-ops sweep repo=https://github.com/org/repo ref=main
@agent-ops can you check whether this repo is ready for agents?
@agent-ops where is the latest readiness report?
@agent-ops read the latest readiness report
@agent-ops runs list
@agent-ops show run <run-id> repo=https://github.com/org/repo
@agent-ops reports latest
@agent-ops code recover <job-id>
```

`code recover` is cleanup-only. It is accepted only from the original user and parent channel after
the original preparation owner has stopped. It marks a still-preparing job interrupted and removes
containers labelled for that job. Repeating it retries cleanup; it never reacquires source, calls a
model, verifies code, grants approval, or publishes.

On `SIGINT` or `SIGTERM`, the bot closes admission, aborts active request scopes, removes workers,
and waits up to `DISCORD_SHUTDOWN_GRACE_MS` for handlers to drain. It then performs owner-scoped
forced worker cleanup before closing Discord transports. Interrupted work is not replayed.

If `DISCORD_DEFAULT_REPO_PATH` is set, users can omit the repo path:

```text
@agent-ops sweep this repo
```

Completed sweeps post a compact Markdown reply with the run ID, token count, report filename,
first useful report summary, and full report path. Reports are stored in Agent Workflow Runtime managed
state on the bot host. When the file is available, the Discord reply also attaches the generated
`.md` report.

Every Discord sweep also attempts the same fixed-origin public OSSRules reference comparison as the CLI.
The benchmark is internal to the readiness workflow, not a separately exposed Discord plugin
source. The reply and attached report identify `live`, `revalidated`, `stale`, or `unavailable`
benchmark evidence; an ossrules outage does not fail the sweep.

Run and report inspection requests are deterministic and read managed state only. They do not
call MiniMax. Discord inspection uses the explicit repo in the message or
`DISCORD_DEFAULT_REPO_PATH`; when neither is available, the bot asks for a repo instead of
listing every managed target on the host.

The Discord surface enables plugin sources for the chat-agent workflow. Pi sees a stable
tool bridge (`searchTools` and `executeTool`) instead of every plugin function directly. The
model searches enabled plugin tools, selects the exact tool name, and Agent Workflow Runtime executes
that selected tool locally. The readiness source can run a sweep, list runs, show a run, find
the latest report, or read a report. The GitHub source can read repository metadata, recent
Actions runs, open pull requests, open issues, and releases for GitHub-backed targets. GitHub tool
discovery includes each tool's input schema so the model does not have to guess argument names.
Repeated delivery of the same Discord message ID is rejected through durable platform,
bot/application, and message identity so restarts do not duplicate work.
