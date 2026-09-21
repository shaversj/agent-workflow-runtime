interface DiscordDrainResult {
  drained: boolean;
  forced: boolean;
  remainingHandlers: number;
  cleanupFailed: boolean;
}

interface DiscordShutdownOptions {
  graceMs: number;
  cleanup: () => Promise<void>;
  forceCleanup: () => Promise<void>;
}

export class DiscordLifecycle {
  private accepting = true;
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private shutdownOperation?: Promise<DiscordDrainResult>;

  get isAccepting(): boolean {
    return this.accepting;
  }

  run(handler: (signal: AbortSignal) => Promise<void>, onFailure: () => void): boolean {
    if (!this.accepting) return false;
    let operation: Promise<void>;
    try {
      operation = handler(this.controller.signal);
    } catch (error) {
      operation = Promise.reject(
        error instanceof Error ? error : new Error("discord_handler_failed")
      );
    }
    const tracked = operation
      .catch(() => {
        if (this.controller.signal.aborted) return;
        try {
          onFailure();
        } catch {
          // Failure reporting cannot create an unhandled rejection during shutdown.
        }
      })
      .finally(() => this.active.delete(tracked));
    this.active.add(tracked);
    return true;
  }

  shutdown(options: DiscordShutdownOptions): Promise<DiscordDrainResult> {
    this.shutdownOperation ??= this.performShutdown(options);
    return this.shutdownOperation;
  }

  private async performShutdown(options: DiscordShutdownOptions): Promise<DiscordDrainResult> {
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 1 || options.graceMs > 120_000)
      throw new Error("discord_shutdown_grace_invalid");
    this.accepting = false;
    this.controller.abort(new Error("discord_shutdown"));

    let cleanupFailed = false;
    const cleanup = Promise.resolve()
      .then(options.cleanup)
      .catch(() => {
        cleanupFailed = true;
      });
    const drained = await settlesWithin(
      Promise.allSettled([...this.active, cleanup]).then(() => undefined),
      options.graceMs
    );
    if (drained) {
      return { drained: true, forced: false, remainingHandlers: 0, cleanupFailed };
    }

    const forced = await settlesWithin(
      Promise.resolve()
        .then(options.forceCleanup)
        .catch(() => {
          cleanupFailed = true;
        }),
      options.graceMs
    );
    return {
      drained: false,
      forced,
      remainingHandlers: this.active.size,
      cleanupFailed
    };
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
