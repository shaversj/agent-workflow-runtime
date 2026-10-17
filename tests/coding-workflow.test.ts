import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { beginInteraction } from "../src/harness/interaction.js";
import { codingProfileFingerprint } from "../src/harness/coding-runtime.js";
import { openHistoryReader } from "../src/db/index.js";
import { CodingGitHubSource } from "../src/plugins/coding/github-source.js";
import { codingProfile } from "../src/plugins/coding/config.js";
import type { CodingPolicy } from "../src/plugins/coding/config.js";
import { checkpointCandidate, sourceManifestDigest } from "../src/plugins/coding/proposal.js";
import { codingDecision } from "../src/workflows/coding-approval.js";
import { prepareCoding, resumeCoding } from "../src/workflows/code.js";
import { DockerWorker } from "../src/workspaces/docker.js";
import { prepareCodingExecutionDatabase } from "../src/workspaces/storage.js";
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
  it("records source acquisition metadata without unchanged source content", async () => {
    const f = fixture();
    const sourceMarker = "unchanged-source-must-not-enter-shared-history";
    const baseline = [{ path: "app.js", content: `${sourceMarker}\n`, mode: "100644" as const }];
    const source = new CodingGitHubSource();
    vi.spyOn(source, "base").mockResolvedValue(f.job.baseCommit);
    vi.spyOn(source, "files").mockResolvedValue(baseline);
    try {
      await expect(
        prepareCoding(
          { repository: "owner/repo", baseBranch: "main", task: "Fix" },
          f.principal,
          f.policy,
          f.recording,
          {
            source,
            preflight: () => Promise.resolve(),
            turn: () => Promise.reject(new Error("coding_model_failed"))
          }
        )
      ).rejects.toThrow("coding_model_failed");

      const reader = openHistoryReader({ home: f.home })!;
      try {
        const run = reader
          .listRuns(f.recording.interactionId)
          .find(({ kind }) => kind === "coding_prepare")!;
        const call = reader
          .listToolCalls(run.id)
          .find(({ name }) => name === "coding.acquire_source")!;
        expect(call.result!.text).not.toContain(sourceMarker);
        expect(JSON.parse(call.result!.text)).toEqual({
          files: 1,
          manifestDigest: sourceManifestDigest(baseline)
        });
      } finally {
        reader.close();
      }
    } finally {
      f.recording.close();
    }
  });

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
  it("uses one absolute deadline and does not leave timed-out work resumable", async () => {
    const f = fixture();
    f.policy.timeoutMs = 1000;
    const source = new CodingGitHubSource();
    vi.spyOn(source, "base").mockResolvedValue(f.job.baseCommit);
    vi.spyOn(source, "files").mockResolvedValue([
      { path: "app.js", content: "module.exports=(a,b)=>a-b;\n", mode: "100644" }
    ]);
    let jobId!: string;
    const turn = vi.fn(
      (options: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () =>
              reject(
                options.signal.reason instanceof Error
                  ? options.signal.reason
                  : new Error("coding_deadline_exceeded")
              ),
            { once: true }
          );
        })
    );
    try {
      await expect(
        prepareCoding(
          { repository: "owner/repo", baseBranch: "main", task: "Fix" },
          f.principal,
          f.policy,
          f.recording,
          {
            source,
            turn,
            preflight: () => Promise.resolve(),
            onJob: (job) => {
              jobId = job.id;
            }
          }
        )
      ).rejects.toThrow("coding_deadline_exceeded");
      expect(f.recording.coding((store) => store.get(jobId, f.principal))).toMatchObject({
        status: "failed",
        reason: "coding_deadline_exceeded"
      });
      const execution = f.recording.coding((store) => store.execution(jobId, f.principal));
      expect(execution.phase).toBe("waiting-runtime");
      expect(execution.ownerToken).toBeUndefined();
    } finally {
      f.recording.close();
    }
  });
  it("rejects a corrupt durable store before repository or model work", async () => {
    const f = fixture();
    const profile = codingProfile(f.policy, f.principal, f.job.repository);
    f.recording.coding((store) =>
      store.create(f.job, {
        task: "Fix",
        profileFingerprint: codingProfileFingerprint(profile, f.policy),
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      })
    );
    f.recording.finishRun({ status: "cancelled", error: "simulated_process_exit" });
    f.recording.finishInteraction({ status: "cancelled", error: "simulated_process_exit" });
    f.recording.close();
    fs.writeFileSync(prepareCodingExecutionDatabase(f.job.id, f.home), "not sqlite");

    const resumed = beginInteraction(
      { source: "cli", kind: "code-resume", userMessage: "Resume" },
      { home: f.home }
    );
    const source = new CodingGitHubSource();
    const base = vi.spyOn(source, "base");
    const files = vi.spyOn(source, "files");
    const turn = vi.fn();
    try {
      await expect(
        resumeCoding(f.job.id, f.principal, f.policy, resumed, { source, turn })
      ).rejects.toThrow("coding_preparation_stopped");
      expect(base).not.toHaveBeenCalled();
      expect(files).not.toHaveBeenCalled();
      expect(turn).not.toHaveBeenCalled();
    } finally {
      resumed.close();
    }
  });
  it("accepts durable cancellation from a distinct CLI process", () => {
    const f = fixture();
    try {
      f.recording.coding((store) =>
        store.create(f.job, {
          task: "Fix",
          profileFingerprint: "c".repeat(64),
          deadlineAt: new Date(Date.now() + 1_200_000).toISOString()
        })
      );
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
  it("cleans a cancelled stopped job without reacquiring source or calling the model", async () => {
    const f = fixture();
    const profile = codingProfile(f.policy, f.principal, f.job.repository);
    f.recording.coding((store) =>
      store.create(f.job, {
        task: "Fix",
        profileFingerprint: codingProfileFingerprint(profile, f.policy),
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      })
    );
    f.recording.coding((store) => store.requestCancellation(f.job.id, f.principal));
    f.recording.finishRun({ status: "cancelled", error: "simulated_process_exit" });
    f.recording.finishInteraction({ status: "cancelled", error: "simulated_process_exit" });
    f.recording.close();

    const resumed = beginInteraction(
      { source: "cli", kind: "code-resume", userMessage: "Resume" },
      { home: f.home }
    );
    const source = new CodingGitHubSource();
    const base = vi.spyOn(source, "base");
    const files = vi.spyOn(source, "files");
    const cleanup = vi.spyOn(DockerWorker, "cleanupJob").mockResolvedValue();
    const turn = vi.fn();
    try {
      await expect(
        resumeCoding(f.job.id, f.principal, f.policy, resumed, { source, turn })
      ).rejects.toThrow("coding_cancelled");
      expect(cleanup).toHaveBeenCalledWith(f.job.id);
      expect(base).not.toHaveBeenCalled();
      expect(files).not.toHaveBeenCalled();
      expect(turn).not.toHaveBeenCalled();
      expect(resumed.coding((store) => store.get(f.job.id, f.principal))).toMatchObject({
        status: "interrupted",
        reason: "coding_cancelled"
      });
      const execution = resumed.coding((store) => store.execution(f.job.id, f.principal));
      expect(execution.phase).toBe("waiting-runtime");
      expect(execution).not.toHaveProperty("ownerToken");
    } finally {
      resumed.close();
    }
  });
  it("allows retrying explicit cleanup of an already-expired owned job", () => {
    const f = fixture();
    try {
      f.recording.coding((store) =>
        store.create(
          { ...f.job, expiresAt: new Date(Date.now() - 1).toISOString() },
          {
            task: "Fix",
            profileFingerprint: "c".repeat(64),
            deadlineAt: new Date(Date.now() + 1_200_000).toISOString()
          }
        )
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
    const turn = vi.fn(
      async (
        options: Parameters<
          typeof import("../src/harness/coding-durable.js").runDurableCodingTurn
        >[0]
      ) => {
        await options.start!(options.profile, options.signal, options.jobId, false, options.fence);
        throw new Error("unreachable");
      }
    );
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
            turn,
            preflight: () => Promise.resolve(),
            onJob: (job) => {
              jobId = job.id;
            }
          }
        )
      ).rejects.toThrow(/worker_unavailable/);
      expect(turn).toHaveBeenCalledOnce();
      expect(f.recording.coding((store) => store.get(jobId, f.principal))?.status).toBe("failed");
    } finally {
      f.recording.close();
    }
  });
  it("continues one durable candidate while repairing a failed fresh verification", async () => {
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
    const requestIds: string[] = [];
    let executions = 0;
    const turn = (
      options: Parameters<typeof import("../src/harness/coding-durable.js").runDurableCodingTurn>[0]
    ) => {
      requestIds.push(options.requestId);
      const content =
        executions++ === 0 ? "module.exports=(a,b)=>a*b;\n" : "module.exports=(a,b)=>a+b;\n";
      return Promise.resolve({
        conversationId: 1,
        submissionId: executions,
        summary: executions === 1 ? "First candidate" : "Repaired candidate",
        candidate: checkpointCandidate(
          options.profile,
          options.baseline,
          [{ path: "app.js", content, mode: "100644" }],
          executions
        )
      });
    };
    try {
      const job = await prepareCoding(
        { repository: "owner/repo", baseBranch: "main", task: "Fix addition" },
        f.principal,
        f.policy,
        f.recording,
        { source, worker: start, turn }
      );
      expect(job.status).toBe("proposal-ready");
      expect(starts).toEqual([true, true]);
      expect(executions).toBe(2);
      expect(requestIds).toEqual(["initial", "repair-1"]);
      const proposal = f.recording.coding((store) => store.proposal(job.id, f.principal));
      expect(proposal.summary).toBe("Repaired candidate");
      expect(proposal.files[0]?.content).toContain("a+b");
      expect(proposal.checks).toMatchObject([{ exitCode: 0, truncated: false }]);
    } finally {
      f.recording.close();
    }
  });
  it("resumes the same fenced job from its pinned commit and seals the resumed run", async () => {
    const f = fixture();
    const task = "Fix addition";
    const profile = codingProfile(f.policy, f.principal, f.job.repository);
    const profileFingerprint = codingProfileFingerprint(profile, f.policy);
    const first = f.recording.coding((store) =>
      store.create(f.job, {
        task,
        profileFingerprint,
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      })
    );
    const firstClaim = f.recording.coding((store) => store.claimExecution(first.id, f.principal));
    f.recording.coding((store) => store.releaseExecution(first.id, firstClaim.fence, f.principal));
    f.recording.finishRun({ status: "cancelled", error: "simulated_process_exit" });
    f.recording.close();

    const resumedRecording = beginInteraction(
      { source: "cli", kind: "code", userMessage: `Resume ${first.id}` },
      { home: f.home }
    );
    const source = new CodingGitHubSource();
    const baseline = [
      { path: "app.js", content: "module.exports=(a,b)=>a-b;\n", mode: "100644" as const }
    ];
    const base = vi.spyOn(source, "base");
    const files = vi.spyOn(source, "files").mockResolvedValue(baseline);
    vi.spyOn(DockerWorker, "cleanupJob").mockResolvedValue();
    vi.spyOn(DockerWorker, "cleanupJobFence").mockResolvedValue();
    const worker = vi.fn(() =>
      Promise.resolve({
        id: "resume-verifier",
        profile,
        importFiles: () => Promise.resolve(),
        snapshot: () =>
          Promise.resolve([
            { path: "app.js", content: "module.exports=(a,b)=>a+b;\n", mode: "100644" }
          ]),
        freeze: () => Promise.resolve(),
        close: () => Promise.resolve(),
        command: (command: string) =>
          Promise.resolve({ command, exitCode: 0, output: "passed", truncated: false })
      } as unknown as DockerWorker)
    );
    const turn = vi.fn(
      (
        options: Parameters<
          typeof import("../src/harness/coding-durable.js").runDurableCodingTurn
        >[0]
      ) =>
        Promise.resolve({
          conversationId: 9,
          submissionId: 11,
          summary: "Corrected addition after restart.",
          candidate: checkpointCandidate(
            options.profile,
            options.baseline,
            [
              {
                path: "app.js",
                content: "module.exports=(a,b)=>a+b;\n",
                mode: "100644"
              }
            ],
            1
          )
        })
    );
    try {
      const resumed = await resumeCoding(first.id, f.principal, f.policy, resumedRecording, {
        source,
        worker,
        turn
      });
      expect(resumed).toMatchObject({ id: first.id, status: "proposal-ready" });
      expect(base).not.toHaveBeenCalled();
      expect(files).toHaveBeenCalledWith(
        { repository: first.repository, baseBranch: first.baseBranch, task },
        first.baseCommit,
        expect.any(AbortSignal)
      );
      expect(turn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: first.id, requestId: "initial", fence: 2 })
      );
      const execution = resumedRecording.coding((store) => store.execution(first.id, f.principal));
      expect(execution).toMatchObject({
        fence: 2,
        resumeCount: 1,
        phase: "terminal",
        conversationId: 9,
        taskId: 11
      });
      expect(execution.terminalRunId).not.toBe(first.runId);
      const reader = openHistoryReader({ home: f.home })!;
      try {
        const run = reader
          .listRuns(resumedRecording.interactionId)
          .find((candidate) => candidate.id === execution.terminalRunId);
        expect(run?.metadata.text).toContain('"phase":"terminal"');
        expect(run?.metadata.text).toContain('"resumeCount":1');
        expect(run?.metadata.text).toContain('"conversationId":9');
        expect(run?.metadata.text).not.toContain("ownerToken");
      } finally {
        reader.close();
      }
    } finally {
      resumedRecording.close();
    }
  });

  it("refuses an unfinished job created under a different durable protocol", async () => {
    const f = fixture();
    const source = new CodingGitHubSource();
    const base = vi.spyOn(source, "base");
    const files = vi.spyOn(source, "files");
    const worker = vi.fn();
    f.recording.coding((store) =>
      store.create(f.job, {
        task: "Fix addition",
        profileFingerprint: "0".repeat(64),
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      })
    );

    try {
      await expect(
        resumeCoding(f.job.id, f.principal, f.policy, f.recording, { source, worker })
      ).rejects.toThrow("coding_resume_policy_changed");
      expect(base).not.toHaveBeenCalled();
      expect(files).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
    } finally {
      f.recording.close();
    }
  });
});
