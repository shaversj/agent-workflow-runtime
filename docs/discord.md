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
DISCORD_ENABLED_PLUGIN_SOURCES=readiness
DISCORD_ALLOW_DMS=false
MINIMAX_API_KEY=
```

`DISCORD_BOT_TOKEN` is required. The allowlists are comma-separated Discord IDs. Empty allowlists mean the bot will accept any guild or channel it can see, so production use should set at least `DISCORD_ALLOWED_GUILD_IDS`.

Direct messages are disabled unless `DISCORD_ALLOW_DMS=true`.

`DISCORD_ENABLED_PLUGIN_SOURCES` controls which plugin sources Discord can expose to the
chat-agent workflow. It defaults to `readiness`. Source selection stays at the plugin family
level; individual tools carry metadata such as source, exposure, read-only intent, approval
requirement, and allowed surfaces.

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
@agent-ops can you check whether this repo is ready for agents?
@agent-ops where is the latest readiness report?
@agent-ops read the latest readiness report
```

If `DISCORD_DEFAULT_REPO_PATH` is set, users can omit the repo path:

```text
@agent-ops sweep this repo
```

Completed sweeps post a compact Markdown reply with the run ID, token count, report filename,
first useful report summary, and full report path. When the report file is available on the
bot host, the Discord reply also attaches the generated `.md` report.

The Discord surface enables plugin sources for the chat-agent workflow. Pi sees a stable
tool bridge (`searchTools` and `executeTool`) instead of every plugin function directly. The
model searches enabled plugin tools, selects the exact tool name, and Agent Ops Kit executes
that selected tool locally. The current readiness source can run a sweep, find the latest
report, or read a report. Repeated delivery of the same Discord message ID is ignored in
memory to avoid duplicate local runs.
