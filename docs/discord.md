# Discord Bot

Agent Ops Kit can run the readiness sweep from Discord mentions or direct messages.

## Environment

```bash
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_GUILD_IDS=
DISCORD_ALLOWED_CHANNEL_IDS=
DISCORD_DEFAULT_REPO_PATH=/path/to/repo
DISCORD_DEFAULT_MODEL=MiniMax-M3
DISCORD_TIMEOUT_MS=120000
DISCORD_ALLOW_DMS=false
MINIMAX_API_KEY=
```

`DISCORD_BOT_TOKEN` is required. The allowlists are comma-separated Discord IDs. Empty allowlists mean the bot will accept any guild or channel it can see, so production use should set at least `DISCORD_ALLOWED_GUILD_IDS`.

Direct messages are disabled unless `DISCORD_ALLOW_DMS=true`.

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
```

If `DISCORD_DEFAULT_REPO_PATH` is set, users can omit the repo path:

```text
@agent-ops sweep this repo
```

The bot updates one status reply while the sweep runs, then posts the final summary. Repeated delivery of the same Discord message ID is ignored in memory to avoid duplicate local runs.
