import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preflightCodingLive,
  runCodingLive,
  LiveReceiptSchema,
  parseLiveArgs
} from "../scripts/coding-live.js";
import { CodingGitHubSource } from "../src/plugins/coding/github-source.js";
import type { SourceFile } from "../src/plugins/coding/schemas.js";
import type { DockerWorker } from "../src/workspaces/docker.js";
import { openHistoryReader } from "../src/db/index.js";

const principal = `cli:${process.getuid?.() ?? "unsupported"}`;
const image = `node@sha256:${"a".repeat(64)}`;
const input = () => ({
  scenario: "prepare",
  authorization: { repository: "owner/repo", baseBranch: "main", principal, permittedWrites: [] },
  task: "Fix addition",
  limits: { timeoutMs: 1000, maxModelCalls: 2, maxTokens: 2000 }
});
const env = () => ({
  CODING_ENABLED: "true",
  CODING_PUBLICATION_ENABLED: "true",
  CODING_ALLOWED_PRINCIPALS: JSON.stringify([principal]),
  CODING_PROFILES: JSON.stringify({
    "owner/repo": { image, requiredChecks: ["node --test"], ignore: [], principal }
  }),
  CODING_GITHUB_READ_TOKEN: "read-test-credential",
  CODING_GITHUB_WRITE_TOKEN: "never-load-write-credential",
  MINIMAX_API_KEY: "model-test-credential"
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-live-test-"));
  roots.push(root);
  const source = new CodingGitHubSource();
  const base = vi.spyOn(source, "base").mockResolvedValue("a".repeat(40));
  const files = vi
    .spyOn(source, "files")
    .mockResolvedValue([{ path: "app.js", content: "old\n", mode: "100644" }]);
  const workers: { close: ReturnType<typeof vi.fn>; files: SourceFile[] }[] = [];
  const worker = () => {
    const state = { files: [] as SourceFile[], close: vi.fn(() => Promise.resolve()) };
    workers.push(state);
    return Promise.resolve({
      id: `fixture-${workers.length}`,
      importFiles: (files: SourceFile[]) => {
        state.files = structuredClone(files);
        return Promise.resolve();
      },
      snapshot: () => Promise.resolve(structuredClone(state.files)),
      freeze: () => Promise.resolve(),
      command: (command: string) =>
        Promise.resolve({ command, exitCode: 0, output: "read-test-credential", truncated: false }),
      rpc: (_op: string, _name: string, content: string) => {
        state.files[0]!.content = content;
        return Promise.resolve(true);
      },
      close: state.close
    } as unknown as DockerWorker);
  };
  return { root, source, worker, workers, base, files };
}

describe("opt-in coding live controls", () => {
  it("requires explicit config and does not silently load .env", () => {
    expect(parseLiveArgs(["--config", "scenario.json"])).toEqual({ config: "scenario.json" });
    expect(parseLiveArgs(["--", "--config", "scenario.json", "--env-file", ".env"])).toEqual({
      config: "scenario.json",
      envFile: ".env"
    });
    for (const args of [
      [],
      ["--env-file", ".env"],
      ["--config", "a", "--config", "b"],
      ["--config", "a", "--unknown", "b"]
    ])
      expect(() => parseLiveArgs(args)).toThrow();
  });
  it("refuses missing authorization, writes, unsafe principal and unknown fields before services", async () => {
    const f = fixture();
    for (const value of [
      { ...input(), authorization: undefined },
      { ...input(), authorization: { ...input().authorization, permittedWrites: ["draft-pr"] } },
      { ...input(), authorization: { ...input().authorization, principal: "discord:1" } },
      { ...input(), authorizeEverything: true },
      { ...input(), limits: { ...input().limits, maxModelCalls: 31 } }
    ])
      await expect(
        runCodingLive(value, env(), { root: f.root, source: f.source, worker: f.worker })
      ).rejects.toThrow();
    expect(f.base).not.toHaveBeenCalled();
    expect(f.workers).toHaveLength(0);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it("cannot expand operator targets, principals or budgets and discards write credentials", () => {
    const prepared = preflightCodingLive(input(), { ...env(), CODING_MAX_TOKENS: "1500" });
    expect(prepared.policy.maxTokens).toBe(1500);
    expect(prepared.policy.publicationEnabled).toBe(false);
    expect(prepared.policy.writeToken).toBeUndefined();
    for (const change of [
      { CODING_ENABLED: "false" },
      { CODING_ALLOWED_PRINCIPALS: "[]" },
      { CODING_PROFILES: "{}" },
      { CODING_GITHUB_READ_TOKEN: "" },
      { MINIMAX_API_KEY: "" }
    ])
      expect(() => preflightCodingLive(input(), { ...env(), ...change })).toThrow();
  });
  it("records a simulated preparation truthfully through the real workflow and shared history", async () => {
    const f = fixture();
    const result = await runCodingLive(input(), env(), {
      root: f.root,
      source: f.source,
      worker: f.worker,
      runtime: async (worker, _task, _instructions, recording) => {
        const call = recording.modelStart({ provider: "fixture", model: "fixture" });
        recording.modelFinish({
          id: call,
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        });
        await worker.rpc("write", "app.js", "fixed\n");
        return "Fixed addition";
      }
    });
    expect(Value.Check(LiveReceiptSchema, result.receipt)).toBe(true);
    expect(result.receipt).toMatchObject({
      status: "proposal-ready",
      boundaries: {
        source: "simulated",
        model: "simulated",
        worker: "simulated",
        publication: "not-run"
      },
      modelCalls: 1,
      totalTokens: 15,
      publicationWrites: 0,
      remoteResources: [],
      cleanup: "simulated"
    });
    expect(result.receipt.jobId).toBeDefined();
    expect(result.receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.workers).toHaveLength(2);
    for (const worker of f.workers) expect(worker.close).toHaveBeenCalled();
    const saved = fs.readFileSync(result.receiptPath, "utf8");
    expect(saved).not.toContain("test-credential");
    expect(JSON.parse(saved)).toEqual(result.receipt);
    expect(fs.statSync(result.home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(result.receiptPath).mode & 0o777).toBe(0o600);
    const reader = openHistoryReader({ home: result.home })!;
    try {
      expect(reader.getInteraction(result.receipt.interactionId!)?.status).toBe("completed");
    } finally {
      reader.close();
    }
  });
  it("retains a bounded receipt after errors without leaking HTTP credentials or deleting remote resources", async () => {
    const f = fixture();
    f.files.mockRejectedValue(new Error("Authorization: Bearer read-test-credential"));
    const result = await runCodingLive(input(), env(), {
      root: f.root,
      source: f.source,
      worker: f.worker
    });
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.reason).toBe("coding_live_scenario_failed");
    expect(fs.readFileSync(result.receiptPath, "utf8")).not.toContain("read-test-credential");
    expect(result.receipt.remoteResources).toEqual([]);
  });
  it("refuses a receipt sink that cannot be created before source/model/worker calls", async () => {
    const f = fixture();
    const file = path.join(f.root, "not-a-directory");
    fs.writeFileSync(file, "fixture");
    await expect(
      runCodingLive(input(), env(), { root: file, source: f.source, worker: f.worker })
    ).rejects.toThrow(/coding_live_storage_failed/);
    expect(f.base).not.toHaveBeenCalled();
    expect(f.workers).toHaveLength(0);
  });
  it("interrupts an active scenario at its finite timeout and closes owned workers", async () => {
    const f = fixture();
    const result = await runCodingLive(input(), env(), {
      root: f.root,
      source: f.source,
      worker: f.worker,
      runtime: async (_worker, _task, _instructions, _recording, _policy, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        });
        return "unreachable";
      }
    });
    expect(result.receipt.status).toBe("interrupted");
    expect(f.workers[0]!.close).toHaveBeenCalled();
    expect(result.receipt.publicationWrites).toBe(0);
  });
});
