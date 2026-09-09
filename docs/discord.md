# Discord Bot

Agent Ops Kit can run readiness tools from Discord mentions or direct messages.

## Environment

```bash
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_GUILD_IDS=
DISCORD_ALLOWED_CHANNEL_IDS=
DISCORD_DEFAULT_REPO_PATH=/path/to/repo
DISCORD_DEFAULT_MODEL=MiniMax-M3
DISCORD_TIMEOUT_MS=120000
DISCORD_ENABLED_PLUGIN_SOURCES=readiness,github
DISCORD_ALLOW_DMS=false
MINIMAX_API_KEY=
GITHUB_TOKEN=
```

`DISCORD_BOT_TOKEN` is required. The allowlists are comma-separated Discord IDs. Empty allowlists mean the bot will accept any guild or channel it can see, so production use should set at least `DISCORD_ALLOWED_GUILD_IDS`.

Direct messages are disabled unless `DISCORD_ALLOW_DMS=true`.

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

The bot responds when mentioned in an allowed guild channel:

```text
@agent-ops sweep repo=/Users/wu36/Code/incident-triage-demo
@agent-ops sweep repo=https://github.com/org/repo ref=main
@agent-ops can you check whether this repo is ready for agents?
@agent-ops where is the latest readiness report?
@agent-ops read the latest readiness report
@agent-ops runs list
@agent-ops show run <run-id> repo=https://github.com/org/repo
@agent-ops reports latest
```

If `DISCORD_DEFAULT_REPO_PATH` is set, users can omit the repo path:

```text
@agent-ops sweep this repo
```

Completed sweeps post a compact Markdown reply with the run ID, token count, report filename,
first useful report summary, and full report path. Reports are stored in Agent Ops Kit managed
state on the bot host. When the file is available, the Discord reply also attaches the generated
`.md` report.

Run and report inspection requests are deterministic and read managed state only. They do not
call MiniMax. Discord inspection uses the explicit repo in the message or
`DISCORD_DEFAULT_REPO_PATH`; when neither is available, the bot asks for a repo instead of
listing every managed target on the host.

The Discord surface enables plugin sources for the chat-agent workflow. Pi sees a stable
tool bridge (`searchTools` and `executeTool`) instead of every plugin function directly. The
model searches enabled plugin tools, selects the exact tool name, and Agent Ops Kit executes
that selected tool locally. The readiness source can run a sweep, list runs, show a run, find
the latest report, or read a report. The GitHub source can read repository metadata, recent
Actions runs, open pull requests, open issues, and releases for GitHub-backed targets. GitHub tool
discovery includes each tool's input schema so the model does not have to guess argument names.
Repeated delivery of the same Discord message ID is ignored in memory to avoid duplicate local
runs.
