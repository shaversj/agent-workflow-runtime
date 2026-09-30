import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { beginInteraction } from "../src/harness/interaction.js";
import type { runIsolatedCoding } from "../src/harness/coding-runtime.js";
import { CodingGitHubSource } from "../src/plugins/coding/github-source.js";
import type { CodingPolicy } from "../src/plugins/coding/config.js";
import { codingDecision } from "../src/workflows/coding-approval.js";
import { prepareCoding } from "../src/workflows/code.js";
import { DockerWorker } from "../src/workspaces/docker.js";
import type { CodingProfile } from "../src/workspaces/execution.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-workflow-"));
  homes.push(home);
  const principal = `cli:${process.getuid!()}`;
  const policy: CodingPolicy = {
    enabled: true,
    publicationEnabled: false,
    principals: [principal],
    profiles: {
      "owner/repo": {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal
      }
    },
    model: "MiniMax-M3",
    timeoutMs: 30000,
    maxModelCalls: 3,
    maxTokens: 100000
  };
  const recording = beginInteraction({ source: "cli", kind: "code", userMessage: "Fix" }, { home });
  const job = {
    id: "job",
    principal,
    repository: "owner/repo",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    runId: recording.runId,
    status: "preparing",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString()
  };
  return { home, principal, policy, recording, job };
}
describe("coding lifecycle orchestration", () => {
  it("observes shared-store cancellation while source acquisition is pending", async () => {
    const f = fixture();
    const source = new CodingGitHubSource();
    vi.spyOn(source, "base").mockResolvedValue(f.job.baseCommit);
    vi.spyOn(source, "files").mockImplementation(
      (_task, _commit, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("coding_cancelled")), {
            once: true
          });
        })
    );
    const worker = vi.fn();
    let jobId!: string;
    try {
      await expect(
        prepareCoding(
          { repository: "owner/repo", baseBranch: "main", task: "Fix" },
          f.principal,
          f.policy,
          f.recording,
          {
            source,
            worker,
            onJob: (job) => {
              jobId = job.id;
              f.recording.coding((store) => store.requestCancellation(job.id, f.principal));
            }
          }
        )
      ).rejects.toThrow(/cancelled/);
      expect(worker).not.toHaveBeenCalled();
      expect(f.recording.coding((store) => store.get(jobId, f.principal))?.status).toBe(
        "interrupted"
      );
    } finally {
      f.recording.close();
    }
  });
  it("accepts durable cancellation from a distinct CLI process", () => {
    const f = fixture();
    try {
      f.recording.coding((store) => store.create(f.job));
      const cancelled = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
          path.resolve("src/cli.ts"),
          "code",
          "cancel",
          f.job.id
        ],
        {
          cwd: f.home,
          timeout: 15000,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            AGENT_OPS_HOME: f.home,
            CODING_ENABLED: "true",
            CODING_ALLOWED_PRINCIPALS: JSON.stringify(f.policy.principals),
            CODING_PROFILES: JSON.stringify(f.policy.profiles)
          }
        }
      );
      expect(cancelled.stderr).toBe("");
      expect(cancelled.status).toBe(0);
      expect(f.recording.coding((store) => store.get(f.job.id, f.principal))).toMatchObject({
        cancelRequested: true
      });
    } finally {
      f.recording.close();
    }
  });
  it("allows retrying explicit cleanup of an already-expired owned job", () => {
    const f = fixture();
    try {
      f.recording.coding((store) =>
        store.create({ ...f.job, expiresAt: new Date(Date.now() - 1).toISOString() })
      );
      f.recording.coding((store) => store.transition(f.job.id, "failed", f.principal));
      expect(
        codingDecision({ action: "expire", jobId: f.job.id }, f.principal, f.policy, f.recording)
      ).toBe("expired");
      expect(
        codingDecision({ action: "expire", jobId: f.job.id }, f.principal, f.policy, f.recording)
      ).toBe("expired");
    } finally {
      f.recording.close();
    }
  });
  it("records startup failure without falling back to a host runtime", async () => {
    const f = fixture();
    const source = new CodingGitHubSource();
    vi.spyOn(source, "base").mockResolvedValue(f.job.baseCommit);
    vi.spyOn(source, "files").mockResolvedValue([
      { path: "app.js", content: "safe", mode: "100644" }
    ]);
    vi.spyOn(DockerWorker, "start").mockRejectedValue(new Error("coding_worker_unavailable"));
    const runtime = vi.fn();
    let jobId!: string;
    try {
      await expect(
        prepareCoding(
          { repository: "owner/repo", baseBranch: "main", task: "Fix" },
          f.principal,
          f.policy,
          f.recording,
          {
            source,
            runtime,
            onJob: (job) => {
              jobId = job.id;
            }
          }
        )
      ).rejects.toThrow(/worker_unavailable/);
      expect(runtime).not.toHaveBeenCalled();
      expect(f.recording.coding((store) => store.get(jobId, f.principal))?.status).toBe("failed");
    } finally {
      f.recording.close();
    }
  });
  it("uses one shared budget while repairing a failed fresh verification", async () => {
    const f = fixture();
    const source = new CodingGitHubSource();
    const base = [
      { path: "app.js", content: "module.exports=(a,b)=>a-b;\n", mode: "100644" as const }
    ];
    vi.spyOn(source, "base").mockResolvedValue(f.job.baseCommit);
    vi.spyOn(source, "files").mockResolvedValue(base);
    const starts: boolean[] = [];
    const workers: Array<{
      files: typeof base;
      verification: boolean;
    }> = [];
    const start = vi.fn(
      (
        profile: CodingProfile,
        _signal?: AbortSignal,
        _jobId?: string,
        verification: boolean = false
      ) => {
        const state = { files: [] as typeof base, verification };
        workers.push(state);
        starts.push(verification);
        return Promise.resolve({
          id: `worker-${workers.length}`,
          profile,
          importFiles: (files: typeof base) => {
            state.files = structuredClone(files);
            return Promise.resolve();
          },
          snapshot: () => Promise.resolve(structuredClone(state.files)),
          freeze: () => Promise.resolve(),
          close: () => Promise.resolve(),
          rpc: (op: string, file: string, content?: string) => {
            if (op !== "write") throw new Error("unexpected fake operation");
            state.files = state.files.map((entry) =>
              entry.path === file ? { ...entry, content: content! } : entry
            );
            return Promise.resolve(true);
          },
          command: (command: string) =>
            Promise.resolve({
              command,
              exitCode: state.files[0]?.content.includes("a+b") ? 0 : 1,
              output: state.files[0]?.content.includes("a+b") ? "passed" : "expected addition",
              truncated: false
            })
        } as unknown as DockerWorker);
      }
    );
    const budgets: object[] = [];
    let executions = 0;
    const runtime: typeof runIsolatedCoding = async (
      worker,
      _task,
      _instructions,
      _recording,
      _policy,
      _signal,
      _injected,
      _baseline,
      budget
    ) => {
      budgets.push(budget);
      await worker.rpc(
        "write",
        "app.js",
        executions++ === 0 ? "module.exports=(a,b)=>a*b;\n" : "module.exports=(a,b)=>a+b;\n"
      );
      return executions === 1 ? "First candidate" : "Repaired candidate";
    };
    try {
      const job = await prepareCoding(
        { repository: "owner/repo", baseBranch: "main", task: "Fix addition" },
        f.principal,
        f.policy,
        f.recording,
        { source, worker: start, runtime }
      );
      expect(job.status).toBe("proposal-ready");
      expect(starts).toEqual([false, true, false, true]);
      expect(executions).toBe(2);
      expect(budgets[0]).toBe(budgets[1]);
      const proposal = f.recording.coding((store) => store.proposal(job.id, f.principal));
      expect(proposal.summary).toBe("Repaired candidate");
      expect(proposal.files[0]?.content).toContain("a+b");
      expect(proposal.checks).toMatchObject([{ exitCode: 0, truncated: false }]);
    } finally {
      f.recording.close();
    }
  });
});
