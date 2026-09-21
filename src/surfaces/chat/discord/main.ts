import { loadTrustedEnv, TrustedEnvError } from "../../../env.js";

await bootstrap().catch((error: unknown) => {
  console.error(error instanceof TrustedEnvError ? error.message : "discord_bot.startup_failed");
  process.exitCode = 1;
});

async function bootstrap(): Promise<void> {
  loadTrustedEnv();
  const [{ logger }, { createDiscordClient }, { loadDiscordBotConfig }] = await Promise.all([
    import("../../../logger.js"),
    import("./bot.js"),
    import("./config.js")
  ]);
  const config = loadDiscordBotConfig();
  const client = createDiscordClient(config);
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  client.login(config.token).catch(() => {
    logger.error({ error_category: "discord_login_failed" }, "discord_bot.login_failed");
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
}
