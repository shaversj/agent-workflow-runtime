import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import {
  codingExecutionDirectory,
  prepareCodingExecutionDatabase
} from "../src/workspaces/storage.js";

const homes: string[] = [];
const baseCommit = "a".repeat(40);

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-store-"));
  homes.push(value);
  return value;
}

function owner(token: string, pid = process.pid, host = os.hostname()) {
  return { token, pid, host };
}

function createJob(
  configuredHome: string,
  token = "owner-a",
  pid = process.pid,
  host = os.hostname()
) {
  const store = openHistoryStore({ home: configuredHome, owner: owner(token, pid, host) });
  const accepted = store.acceptInteraction({ source: "cli", kind: "code", userMessage: "Fix" });
  const coding = store.coding(accepted.runId);
  const now = Date.now();
  const job = coding.create(
    {
      id: "job-1",
      principal: "cli:1000",
      repository: "owner/repo",
      baseBranch: "main",
      baseCommit,
      runId: accepted.runId,
      status: "preparing",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString()
    },
    {
      task: "Fix",
      profileFingerprint: "b".repeat(64),
      deadlineAt: new Date(now + 1_200_000).toISOString()
    }
  );
  return { store, accepted, coding, job };
}

describe("durable coding execution ownership", () => {
  it("fences competing owners and rejects stale callbacks", () => {
    const configuredHome = home();
    const first = createJob(configuredHome);
    const firstClaim = first.coding.claimExecution(first.job.id, first.job.principal);
    expect(firstClaim).toMatchObject({ fence: 1, ownerToken: "owner-a", phase: "preparing" });

    const secondStore = openHistoryStore({ home: configuredHome, owner: owner("owner-b") });
    try {
      const accepted = secondStore.acceptInteraction({
        source: "cli",
        kind: "code-resume",
        userMessage: "Resume"
      });
      const second = secondStore.coding(accepted.runId);
      expect(() => second.claimExecution(first.job.id, first.job.principal)).toThrow(
        /execution_owned/
      );
      first.coding.releaseExecution(first.job.id, firstClaim.fence, first.job.principal);
      const secondClaim = second.claimExecution(first.job.id, first.job.principal);
      expect(secondClaim).toMatchObject({ fence: 2, ownerToken: "owner-b", resumeCount: 1 });
      expect(() =>
        first.coding.updateExecution(first.job.id, firstClaim.fence, first.job.principal, {
          phase: "verifying"
        })
      ).toThrow(/ownership_lost/);
    } finally {
      secondStore.close();
      first.store.close();
    }
  });

  it("blocks a second run owned by the same process token", () => {
    const configuredHome = home();
    const first = createJob(configuredHome);
    first.coding.claimExecution(first.job.id, first.job.principal);
    try {
      const accepted = first.store.acceptInteraction({
        source: "cli",
        kind: "code-resume",
        userMessage: "Resume again"
      });
      expect(() =>
        first.store.coding(accepted.runId).claimExecution(first.job.id, first.job.principal)
      ).toThrow(/execution_owned/);
    } finally {
      first.store.close();
    }
  });

  it("does not allow retention cleanup while a live execution owns the durable store", () => {
    const configuredHome = home();
    const first = createJob(configuredHome);
    const claim = first.coding.claimExecution(first.job.id, first.job.principal);
    expect(() => first.coding.assertExecutionRemovable(first.job.id, first.job.principal)).toThrow(
      /cleanup_active/
    );
    first.coding.releaseExecution(first.job.id, claim.fence, first.job.principal);
    expect(() =>
      first.coding.assertExecutionRemovable(first.job.id, first.job.principal)
    ).not.toThrow();
    first.store.close();
  });

  it("requires an explicit cleanup claim for a cancelled stopped job", () => {
    const configuredHome = home();
    const first = createJob(configuredHome);
    first.coding.requestCancellation(first.job.id, first.job.principal);
    expect(() => first.coding.claimExecution(first.job.id, first.job.principal)).toThrow(
      /execution_unavailable/
    );
    expect(
      first.coding.claimExecution(first.job.id, first.job.principal, { allowCancelled: true })
    ).toMatchObject({ fence: 1, phase: "preparing" });
    first.store.close();
  });

  it("reclaims only a provably dead same-host owner", () => {
    const configuredHome = home();
    const first = createJob(configuredHome, "dead-owner", 2_000_000_000);
    first.coding.claimExecution(first.job.id, first.job.principal);

    const secondStore = openHistoryStore({ home: configuredHome, owner: owner("replacement") });
    try {
      const accepted = secondStore.acceptInteraction({
        source: "cli",
        kind: "code-resume",
        userMessage: "Resume"
      });
      const claimed = secondStore
        .coding(accepted.runId)
        .claimExecution(first.job.id, first.job.principal);
      expect(claimed).toMatchObject({ fence: 2, ownerToken: "replacement", resumeCount: 1 });
    } finally {
      secondStore.close();
      first.store.close();
    }
  });

  it("reclaims a fence held by a process killed after acquisition", async () => {
    const configuredHome = home();
    const first = createJob(configuredHome);
    first.store.close();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import os from "node:os";
          import { openHistoryStore } from "./src/db/index.ts";
          const store = openHistoryStore({
            home: process.argv[1],
            owner: { token: "killed-owner", pid: process.pid, host: os.hostname() }
          });
          const accepted = store.acceptInteraction({
            source: "cli",
            kind: "code-resume",
            userMessage: "Resume"
          });
          const execution = store.coding(accepted.runId).claimExecution("job-1", "cli:1000");
          process.send(execution);
          setInterval(() => undefined, 1000);
        `,
        configuredHome
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );

    try {
      const [claimed] = (await once(child, "message")) as [{ fence: number; ownerToken: string }];
      expect(claimed).toMatchObject({ fence: 1, ownerToken: "killed-owner" });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;

      const replacement = openHistoryStore({
        home: configuredHome,
        owner: owner("replacement")
      });
      try {
        const accepted = replacement.acceptInteraction({
          source: "cli",
          kind: "code-resume",
          userMessage: "Resume"
        });
        expect(
          replacement.coding(accepted.runId).claimExecution("job-1", "cli:1000")
        ).toMatchObject({ fence: 2, ownerToken: "replacement", resumeCount: 1 });
      } finally {
        replacement.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 10_000);

  it("keeps a foreign owner blocked", () => {
    const configuredHome = home();
    const first = createJob(configuredHome, "foreign-owner", process.pid, "another-host");
    first.coding.claimExecution(first.job.id, first.job.principal);
    first.store.close();

    const sqlite = openHistoryStore({ home: configuredHome, owner: owner("local-owner") });
    try {
      const coding = sqlite.coding(
        sqlite.acceptInteraction({ source: "cli", kind: "code-resume", userMessage: "Resume" })
          .runId
      );
      expect(() => coding.claimExecution(first.job.id, first.job.principal)).toThrow(
        /execution_owned/
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("durable coding execution storage", () => {
  it("creates an owner-only database under a validated job directory", () => {
    const configuredHome = home();
    const databasePath = prepareCodingExecutionDatabase("job-1", configuredHome);
    expect(databasePath).toBe(
      path.join(codingExecutionDirectory("job-1", configuredHome), "execution.sqlite")
    );
    expect(fs.statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(() => prepareCodingExecutionDatabase("../escape", configuredHome)).toThrow(/id_invalid/);
  });

  it("rejects symlinked execution directories and database files", () => {
    const configuredHome = home();
    const outside = home();
    fs.mkdirSync(path.join(configuredHome, "history"), { mode: 0o700 });
    fs.symlinkSync(outside, path.join(configuredHome, "history", "coding"));
    expect(() => prepareCodingExecutionDatabase("job-1", configuredHome)).toThrow(/path_denied/);
  });
});
