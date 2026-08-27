export interface DiscordBotConfig {
  token: string;
  allowedGuildIds: Set<string>;
  allowedChannelIds: Set<string>;
  defaultRepoPath?: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  allowDms: boolean;
}

export function loadDiscordBotConfig(env: NodeJS.ProcessEnv = process.env): DiscordBotConfig {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

  return {
    token,
    allowedGuildIds: csvSet(env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: csvSet(env.DISCORD_ALLOWED_CHANNEL_IDS),
    defaultRepoPath: optionalEnv(env.DISCORD_DEFAULT_REPO_PATH),
    defaultModel: optionalEnv(env.DISCORD_DEFAULT_MODEL ?? env.HARNESS_MODEL),
    defaultTimeoutMs: positiveIntegerEnv(env.DISCORD_TIMEOUT_MS ?? env.TIMEOUT_MS),
    allowDms: booleanEnv(env.DISCORD_ALLOW_DMS)
  };
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
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("DISCORD_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function booleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
