import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DiscordLifecycle } from "../src/surfaces/chat/discord/lifecycle.js";
import { acquireMirrorLock } from "../src/workspaces/lock.js";
import { parseTargetRef } from "../src/workspaces/target.js";
import { targetStorageKey } from "../src/workspaces/storage.js";

describe("Discord lifecycle", () => {
  it("closes admission, aborts handlers, cleans workers, and drains", async () => {
    const lifecycle = new DiscordLifecycle();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const forceCleanup = vi.fn().mockResolvedValue(undefined);
    const failure = vi.fn();
    let observedAbort = false;

    expect(
      lifecycle.run(
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true }
            );
          }),
        failure
      )
    ).toBe(true);

    const result = await lifecycle.shutdown({ graceMs: 100, cleanup, forceCleanup });

    expect(observedAbort).toBe(true);
    expect(result).toEqual({
      drained: true,
      forced: false,
      remainingHandlers: 0,
      cleanupFailed: false
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(forceCleanup).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(lifecycle.isAccepting).toBe(false);
    expect(lifecycle.run(() => Promise.resolve(), failure)).toBe(false);
  });

  it("bounds a stuck handler and escalates owner-scoped cleanup", async () => {
    const lifecycle = new DiscordLifecycle();
    lifecycle.run(() => new Promise<void>(() => {}), vi.fn());
    const forceCleanup = vi.fn().mockResolvedValue(undefined);
    const started = Date.now();

    const result = await lifecycle.shutdown({
      graceMs: 20,
      cleanup: () => new Promise<void>(() => {}),
      forceCleanup
    });

    expect(Date.now() - started).toBeLessThan(100);
    expect(result).toEqual({
      drained: false,
      forced: true,
      remainingHandlers: 1,
      cleanupFailed: false
    });
    expect(forceCleanup).toHaveBeenCalledOnce();
  });

  it("contains handler and cleanup failures without rejecting shutdown", async () => {
    const lifecycle = new DiscordLifecycle();
    const failure = vi.fn(() => {
      throw new Error("reporting failed");
    });
    lifecycle.run(() => Promise.reject(new Error("handler failed")), failure);
    await Promise.resolve();

    const result = await lifecycle.shutdown({
      graceMs: 100,
      cleanup: () => Promise.reject(new Error("cleanup failed")),
      forceCleanup: () => Promise.resolve()
    });

    expect(failure).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ drained: true, cleanupFailed: true });
  });

  it("aborts a handler waiting on a live mirror owner", async () => {
    const previous = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "discord-lifecycle-"));
    const identity = targetStorageKey(parseTargetRef("https://github.com/acme/waiting.git"));
    const owner = await acquireMirrorLock(identity);
    const lifecycle = new DiscordLifecycle();
    const failure = vi.fn();

    try {
      lifecycle.run(async (signal) => {
        const lease = await acquireMirrorLock(identity, { signal, timeoutMs: 2_000 });
        lease.release();
      }, failure);

      const result = await lifecycle.shutdown({
        graceMs: 100,
        cleanup: () => Promise.resolve(),
        forceCleanup: () => Promise.resolve()
      });

      expect(result).toMatchObject({ drained: true, remainingHandlers: 0 });
      expect(failure).not.toHaveBeenCalled();
    } finally {
      owner.release();
      if (previous === undefined) delete process.env.AGENT_OPS_HOME;
      else process.env.AGENT_OPS_HOME = previous;
    }
  });
});
