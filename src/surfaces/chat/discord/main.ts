import { loadTrustedEnv, TrustedEnvError } from "../../../env.js";
import { projectExternalError } from "../../../harness/external-error.js";

await bootstrap().catch((error: unknown) => {
  console.error(error instanceof TrustedEnvError ? error.message : "discord_bot.startup_failed");
  process.exitCode = 1;
});

async function bootstrap(): Promise<void> {
  loadTrustedEnv();
  const [
    { logger },
    { createDiscordClient },
    { loadDiscordBotConfig },
    { DiscordLifecycle },
    { DockerWorker }
  ] = await Promise.all([
    import("../../../logger.js"),
    import("./bot.js"),
    import("./config.js"),
    import("./lifecycle.js"),
    import("../../../workspaces/docker.js")
  ]);
  const config = loadDiscordBotConfig();
  const lifecycle = new DiscordLifecycle();
  const client = createDiscordClient(config, { lifecycle });
  let shuttingDown = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(() => {
        logger.error(projectExternalError("discord_gateway_failed"), "discord_bot.shutdown_failed");
        process.exitCode = 1;
      });
    });
  }

  client.login(config.token).catch(() => {
    logger.error(projectExternalError("discord_gateway_failed"), "discord_bot.login_failed");
    process.exitCode = 1;
  });

  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ surface: "discord", signal }, "discord_bot.shutdown_started");
    try {
      const result = await lifecycle.shutdown({
        graceMs: config.shutdownGraceMs,
        cleanup: () => DockerWorker.closeOwnedWorkers(),
        forceCleanup: () => DockerWorker.forceCleanupOwnedWorkers()
      });
      logger.info({ surface: "discord", ...result }, "discord_bot.handlers_drained");
      await client.destroy();
    } finally {
      await client.rest.agent?.destroy();
    }
    logger.info({ surface: "discord", signal }, "discord_bot.shutdown_completed");
  }
}
