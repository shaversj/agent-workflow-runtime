import { Type } from "typebox";
import { Value } from "typebox/value";

export interface DiscordBotConfig {
  token: string;
  allowedUserIds: Set<string>;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  localRepoUserIds: Set<string>;
  defaultRepoPath?: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  enabledPluginSources: Set<string>;
  allowDms: false;
}

const DiscordIdSchema = Type.String({ pattern: "^[0-9]{5,32}$" });

export function loadDiscordBotConfig(env: NodeJS.ProcessEnv = process.env): DiscordBotConfig {
  const token = optionalEnv(env.DISCORD_BOT_TOKEN);
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
  const allowedUserIds = discordIdSet(env.DISCORD_ALLOWED_USER_IDS, "DISCORD_ALLOWED_USER_IDS");
  const allowedGuildIds = discordIdSet(env.DISCORD_ALLOWED_GUILD_IDS, "DISCORD_ALLOWED_GUILD_IDS");
  const allowedChannelIds = discordIdSet(
    env.DISCORD_ALLOWED_CHANNEL_IDS,
    "DISCORD_ALLOWED_CHANNEL_IDS"
  );
  const localRepoUserIds = discordIdSet(
    env.DISCORD_LOCAL_REPO_USER_IDS,
    "DISCORD_LOCAL_REPO_USER_IDS"
  );
  if (allowedUserIds.size === 0) throw new Error("DISCORD_ALLOWED_USER_IDS is required");
  if (allowedGuildIds.size === 0 && allowedChannelIds.size === 0) {
    throw new Error("At least one Discord guild or channel allowlist is required");
  }
  if (booleanEnv(env.DISCORD_ALLOW_DMS)) throw new Error("Discord direct messages are disabled");
  for (const userId of localRepoUserIds) {
    if (!allowedUserIds.has(userId)) {
      throw new Error("DISCORD_LOCAL_REPO_USER_IDS must be a subset of allowed users");
    }
  }
  const defaultRepoPath = optionalEnv(env.DISCORD_DEFAULT_REPO_PATH);
  if (defaultRepoPath && !/^https:\/\//i.test(defaultRepoPath) && localRepoUserIds.size === 0) {
    throw new Error("Local default repositories require DISCORD_LOCAL_REPO_USER_IDS");
  }

  return {
    token,
    allowedUserIds,
    allowedGuildIds,
    allowedChannelIds,
    localRepoUserIds,
    defaultRepoPath,
    defaultModel: optionalEnv(env.DISCORD_DEFAULT_MODEL ?? env.HARNESS_MODEL),
    defaultTimeoutMs: positiveIntegerEnv(env.DISCORD_TIMEOUT_MS ?? env.TIMEOUT_MS),
    enabledPluginSources: csvSet(env.DISCORD_ENABLED_PLUGIN_SOURCES ?? "readiness,github"),
    allowDms: false
  };
}

function discordIdSet(value: string | undefined, name: string): Set<string> {
  const values = csvSet(value);
  for (const id of values) {
    if (!Value.Check(DiscordIdSchema, id))
      throw new Error(`${name} contains an invalid Discord ID`);
  }
  return values;
}

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveIntegerEnv(value: string | undefined): number | undefined {
  const trimmed = optionalEnv(value);
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error("DISCORD_TIMEOUT_MS must be a positive integer");
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("DISCORD_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function booleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
