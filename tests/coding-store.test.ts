import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openHistoryStore, openHistoryReader } from "../src/db/index.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const sha = "a".repeat(40),
  digest = "b".repeat(64);
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-store-"));
  homes.push(home);
  const store = openHistoryStore({ home });
  const accepted = store.acceptInteraction({ source: "cli", kind: "code", userMessage: "Fix" });
  const coding = store.coding(accepted.runId);
  const job = {
    id: "job-1",
    principal: "cli:1000",
    repository: "owner/repo",
    baseBranch: "main",
    baseCommit: sha,
    runId: accepted.runId,
    status: "preparing",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString()
  };
  const proposal = {
    id: "proposal-1",
    jobId: job.id,
    digest,
    repository: job.repository,
    baseBranch: job.baseBranch,
    baseCommit: sha,
    files: [],
    deleted: ["old.ts"],
    checks: [{ command: "node --test", exitCode: 0, output: "passed", truncated: false }],
    task: "Fix",
    summary: "Fixed",
    branch: "agent-ops/job-1",
    title: "Fix",
    body: "Reviewed fix",
    createdAt: job.createdAt
  };
  return { home, store, accepted, coding, job, proposal };
}
describe("coding lifecycle in shared history", () => {
  it("permits cleanup recovery to be retried only after the preparation owner stops", () => {
    const { store, accepted, coding, job } = fixture();
    try {
      coding.create(job);
      expect(() => coding.recover(job.id, job.principal)).toThrow(/recovery_unavailable/);
      store.finishInteraction({ id: accepted.interactionId, status: "failed" });
      const next = store.acceptInteraction({
        source: "cli",
        kind: "recover",
        userMessage: "Recover"
      });
      const recovery = store.coding(next.runId);
      expect(recovery.recover(job.id, job.principal).status).toBe("interrupted");
      expect(recovery.recover(job.id, job.principal).status).toBe("interrupted");
    } finally {
      store.close();
    }
  });
  it("rolls back a failed additive upgrade without changing schema version or history", () => {
    const { store, home, accepted } = fixture();
    store.close();
    const file = historyDatabasePath(home);
    const db = new Database(file);
    db.exec(
      "DROP TABLE coding_publication; DROP TABLE coding_approval; DROP TABLE coding_proposal; DROP TABLE coding_job; CREATE TABLE coding_approval (collision TEXT)"
    );
    db.pragma("user_version = 1");
    db.close();
    expect(() => openHistoryStore({ home })).toThrow();
    const inspect = new Database(file, { readonly: true });
    try {
      expect(inspect.pragma("user_version", { simple: true })).toBe(1);
      expect(
        inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'coding_job'").get()
      ).toBeUndefined();
      expect(
        inspect.prepare("SELECT id FROM interaction WHERE id = ?").get(accepted.interactionId)
      ).toBeDefined();
    } finally {
      inspect.close();
    }
  });
  it("seals immutable proposals and binds/consumes approval exactly once across connections", () => {
    const { store, accepted, coding, job, proposal, home } = fixture();
    try {
      coding.create(job);
      coding.seal(job.id, proposal, job.principal);
      expect(() => coding.seal(job.id, proposal, job.principal)).toThrow();
      expect(() => coding.approve(job.id, digest, job.principal)).toThrow(/unavailable/);
      store.finishInteraction({ id: accepted.interactionId, status: "completed" });
      const next = store.acceptInteraction({
        source: "cli",
        kind: "approve",
        userMessage: "Approve"
      });
      const approving = store.coding(next.runId);
      expect(approving.get(job.id, job.principal)?.status).toBe("proposal-ready");
      expect(() => approving.get(job.id, "discord:other")).toThrow(/principal/);
      expect(() => approving.approve(job.id, "wrong", job.principal)).toThrow(/digest/);
      const approval = approving.approve(job.id, digest, job.principal);
      const operation = approving.claim(approval.id, job.principal);
      expect(operation.status).toBe("publishing");
      const other = openHistoryStore({ home });
      try {
        const a = other.acceptInteraction({ source: "cli", kind: "approve", userMessage: "Again" });
        expect(() => other.coding(a.runId).claim(approval.id, job.principal)).toThrow();
      } finally {
        other.close();
      }
      expect(approving.get(job.id, job.principal)?.status).toBe("publishing");
    } finally {
      store.close();
    }
  });
  it("upgrades only supported shared stores on writable opens, preserving existing history", () => {
    const { store, home, accepted } = fixture();
    store.close();
    const db = new Database(historyDatabasePath(home));
    db.exec(
      "DROP TABLE coding_publication; DROP TABLE coding_approval; DROP TABLE coding_proposal; DROP TABLE coding_job"
    );
    db.pragma("user_version = 1");
    db.close();
    expect(() => openHistoryReader({ home })).toThrow(/version/);
    const upgraded = openHistoryStore({ home });
    try {
      expect(upgraded.getInteraction(accepted.interactionId)?.source).toBe("cli");
    } finally {
      upgraded.close();
    }
    const inspect = new Database(historyDatabasePath(home), { readonly: true });
    expect(inspect.pragma("user_version", { simple: true })).toBe(2);
    inspect.close();
  });
  it("blocks unverified proposals, rejects revoked access and does not allow late writes", () => {
    const { store, coding, job, proposal, accepted } = fixture();
    try {
      coding.create(job);
      coding.seal(
        job.id,
        { ...proposal, checks: [{ ...proposal.checks[0]!, exitCode: 1 }] },
        job.principal
      );
      expect(coding.get(job.id, job.principal)?.status).toBe("blocked");
      expect(() => coding.approve(job.id, digest, job.principal)).toThrow();
      store.finishInteraction({ id: accepted.interactionId, status: "completed" });
      expect(() => coding.transition(job.id, "rejected", job.principal)).toThrow();
    } finally {
      store.close();
    }
  });
});
