import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { beginInteraction, flushPendingInteractionFailures } from "../src/harness/interaction.js";
import { freezeProposal } from "../src/plugins/coding/proposal.js";
import type { CodingPolicy } from "../src/plugins/coding/config.js";
import { GitHubPublicationClient } from "../src/plugins/github-publication/client.js";
import { publishProposal } from "../src/workflows/publish-proposal.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

function fixture(conversationKey?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-publication-"));
  const principal = "discord:1",
    repository = "owner/repo";
  const policy: CodingPolicy = {
    enabled: true,
    publicationEnabled: true,
    principals: [principal],
    profiles: {
      [repository]: {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal
      }
    },
    model: "MiniMax-M3",
    timeoutMs: 30000,
    maxModelCalls: 3,
    maxTokens: 10000,
    writeToken: "test-write-only"
  };
  const preparation = beginInteraction(
    { source: "cli", kind: "code", userMessage: "Fix" },
    { home }
  );
  const job = preparation.coding((store) =>
    store.create({
      id: "job",
      principal,
      repository,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      runId: preparation.runId,
      status: "preparing",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...(conversationKey ? { conversationKey } : {})
    })
  );
  const files = ["first.js", "second.js"].map((path) => ({
    path,
    content: "new",
    mode: "100644" as const
  }));
  const proposal = freezeProposal(
    {
      id: "proposal",
      jobId: "job",
      repository,
      baseBranch: "main",
      baseCommit: job.baseCommit,
      task: "Fix",
      summary: "Fixed",
      createdAt: new Date().toISOString()
    },
    [],
    files,
    [{ command: "node --test", exitCode: 0, output: "passed", truncated: false }]
  );
  preparation.coding((store) => store.seal(job.id, proposal, principal));
  preparation.finishRun({ status: "completed" });
  preparation.finishInteraction({ status: "completed" });
  preparation.close();
  const recording = beginInteraction(
    { source: "cli", kind: "approve", userMessage: "Approve" },
    { home }
  );
  return {
    home,
    policy,
    job,
    proposal,
    recording,
    cleanup() {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

describe("publication denial and fatal-history boundaries", () => {
  it("denies reconciliation while the durable publication owner is still active", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const client = new GitHubPublicationClient("test", async () => {
      if (++requests === 1) await held;
      return Response.json({ object: { sha: "b".repeat(40) } });
    });
    const initial = publishProposal(
      f.job.id,
      f.proposal.digest,
      f.job.principal,
      f.policy,
      f.recording,
      false,
      client
    ).catch(() => {});
    try {
      await vi.waitFor(() => expect(requests).toBe(1));
      await expect(
        publishProposal(
          f.job.id,
          f.proposal.digest,
          f.job.principal,
          f.policy,
          f.recording,
          true,
          client
        )
      ).rejects.toThrow(/publication_active/);
      expect(requests).toBe(1);
    } finally {
      release();
      await initial;
      f.cleanup();
    }
  });
  it("denies wrong principal, digest, conversation and changed required checks before any remote request", async () => {
    const f = fixture("guild:channel");
    let requests = 0;
    const client = new GitHubPublicationClient("test", () => {
      ++requests;
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    try {
      for (const [principal, digest, conversation] of [
        ["discord:2", f.proposal.digest, "guild:channel"],
        [f.job.principal, "b".repeat(64), "guild:channel"],
        [f.job.principal, f.proposal.digest, "wrong:channel"]
      ])
        await expect(
          publishProposal(
            f.job.id,
            digest!,
            principal!,
            f.policy,
            f.recording,
            false,
            client,
            conversation
          )
        ).rejects.toThrow();
      const changed = {
        ...f.policy,
        profiles: {
          [f.job.repository]: {
            ...f.policy.profiles[f.job.repository]!,
            requiredChecks: ["different"]
          }
        }
      };
      await expect(
        publishProposal(
          f.job.id,
          f.proposal.digest,
          f.job.principal,
          changed,
          f.recording,
          false,
          client,
          "guild:channel"
        )
      ).rejects.toThrow();
      expect(requests).toBe(0);
      expect(() => f.recording.assertHealthy()).not.toThrow();
    } finally {
      f.cleanup();
    }
  });
  it("rejects a moved base without creating content, branches or PRs", async () => {
    const f = fixture();
    let writes = 0;
    const client = new GitHubPublicationClient("test", (_url, init) => {
      if (init?.method === "POST") ++writes;
      return Promise.resolve(Response.json({ object: { sha: "b".repeat(40) } }));
    });
    try {
      await expect(
        publishProposal(
          f.job.id,
          f.proposal.digest,
          f.job.principal,
          f.policy,
          f.recording,
          false,
          client
        )
      ).rejects.toThrow(/base_moved/);
      expect(writes).toBe(0);
    } finally {
      f.cleanup();
    }
  });
  it("a failed durable remote-stage result prevents the next blob write", async () => {
    const f = fixture(),
      db = new Database(historyDatabasePath(f.home));
    let writes = 0;
    const client = new GitHubPublicationClient("test", async (url, init) => {
      const request = new Request(url, init),
        endpoint = request.url.split("/repos/owner/repo/")[1]!;
      if (endpoint.startsWith("git/ref/heads/main"))
        return Response.json({ object: { sha: f.job.baseCommit } });
      if (endpoint.startsWith("git/ref/heads/agent-ops"))
        return new Response(null, { status: 404 });
      if (endpoint.startsWith("git/commits/"))
        return Response.json({ sha: f.job.baseCommit, tree: { sha: "b".repeat(40) } });
      if (endpoint.startsWith("git/trees/"))
        return Response.json({ sha: "b".repeat(40), tree: [], truncated: false });
      if (endpoint === "git/blobs") {
        await request.text();
        ++writes;
        db.exec(
          "CREATE TRIGGER fail_coding_stage BEFORE UPDATE ON tool_call BEGIN SELECT RAISE(ABORT,'private-error'); END"
        );
        return Response.json({ sha: "c".repeat(40) });
      }
      throw new Error("unexpected request");
    });
    try {
      await expect(
        publishProposal(
          f.job.id,
          f.proposal.digest,
          f.job.principal,
          f.policy,
          f.recording,
          false,
          client
        )
      ).rejects.toThrow(/history_recording_failed/);
      expect(writes).toBe(1);
      expect(f.recording.signal.aborted).toBe(true);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_coding_stage");
      db.close();
      flushPendingInteractionFailures();
      f.cleanup();
    }
  });
});
