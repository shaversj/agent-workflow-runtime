import { loadLocalEnv } from "../../../env.js";
import { logger } from "../../../logger.js";
import { createDiscordClient } from "./bot.js";
import { loadDiscordBotConfig } from "./config.js";

loadLocalEnv();

const config = loadDiscordBotConfig();
const client = createDiscordClient(config);
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

client.login(config.token).catch((error: unknown) => {
  logger.error(
    {
      err: error,
      error_type: error instanceof Error ? error.name : typeof error,
      error: error instanceof Error ? error.message : String(error)
    },
    "discord_bot.login_failed"
  );
  process.exitCode = 1;
});

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ surface: "discord", signal }, "discord_bot.shutdown_started");
  try {
    await client.destroy();
  } finally {
    await client.rest.agent?.destroy();
  }
  logger.info({ surface: "discord", signal }, "discord_bot.shutdown_completed");
}
