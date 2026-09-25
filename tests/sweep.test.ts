import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { request as undiciRequest } from "undici";

import { runSweepWorkflow } from "../src/workflows/sweep.js";
import { historyDatabasePath, historyArtifactsPath } from "../src/workspaces/storage.js";
import { openHistoryReader } from "../src/db/index.js";
import { beginInteraction, flushPendingInteractionFailures } from "../src/harness/interaction.js";
import { WorkflowResultSchema } from "../src/harness/schemas.js";
import * as workspaceTools from "../src/workspaces/index.js";
import * as readinessEvidence from "../src/plugins/readiness/evidence.js";
import { readinessTools } from "../src/plugins/readiness/tools.js";

const sweepHarnessState = vi.hoisted(() => ({
  prompts: [] as string[],
  complete: vi.fn()
}));

vi.mock("../src/harness/model.js", async () => {
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  return {
    createMinimaxHarnessModel: () => ({
      modelProvider: "minimax",
      modelRuntime: "pi-ai",
      name: "MiniMax-M3",
      model: {
        id: "fake",
        api: "openai-completions",
        provider: "minimax",
        reasoning: false
      },
      models: {
        streamSimple: async (
          _model: unknown,
          input: { messages: { role: string; content: string }[] },
          options: { signal: AbortSignal }
        ) => {
          const user = [...input.messages].reverse().find((message) => message.role === "user");
          const content = user?.content as unknown;
          sweepHarnessState.prompts.push(
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter(
                      (item: unknown): item is { type: "text"; text: string } =>
                        typeof item === "object" &&
                        item !== null &&
                        "type" in item &&
                        item.type === "text" &&
                        "text" in item &&
                        typeof item.text === "string"
                    )
                    .map((item) => item.text)
                    .join("\n")
                : ""
          );
          const override: unknown = await sweepHarnessState.complete(input, options);
          const partial =
            override && typeof override === "object"
              ? (override as Record<string, unknown>)
              : {
                  content: [
                    {
                      type: "text",
                      text: "## Overall Judgment\n\nRepository is ready with GitHub context."
                    }
                  ],
                  usage: {
                    input: 10,
                    output: 20,
                    totalTokens: 30,
                    cost: { total: 0 }
                  }
                };
          const message = {
            role: "assistant" as const,
            api: "openai-completions" as const,
            provider: "minimax",
            model: "fake",
            content: [],
            stopReason: "stop" as const,
            timestamp: Date.now(),
            ...partial
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: message.stopReason, message });
          return stream;
        }
      }
    })
  };
});

let isolatedHome: string;
beforeEach(() => {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-failure-"));
  vi.stubEnv("AGENT_OPS_HOME", isolatedHome);
  vi.stubEnv("HOME", isolatedHome);
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  sweepHarnessState.complete.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  flushPendingInteractionFailures();
  vi.unstubAllEnvs();
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe("sweep workflow", () => {
  it("records a skipped report when MiniMax credentials are missing", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(repoPath);

      expect(result.status).toBe("skipped");
      expect(result.target).toEqual({
        source: "local-git",
        origin: fs.realpathSync(repoPath),
        ref: "HEAD",
        commitSha: result.workspace?.commitSha
      });
      expect(result.workspace?.origin).toBe(fs.realpathSync(repoPath));
      expect(result.workspace?.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(result.workspace?.path && fs.existsSync(result.workspace.path)).toBe(false);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]?.name).toBe("gather_readiness_evidence");
      expect(fs.existsSync(result.reportPath!)).toBe(true);
      expect(fs.readFileSync(result.reportPath!, "utf8")).toContain("MINIMAX_API_KEY");
      expect(result.reportPath!.startsWith(fs.realpathSync(historyArtifactsPath()))).toBe(true);
      expect(fs.existsSync(historyDatabasePath())).toBe(true);
      expect(fs.existsSync(path.join(agentOpsHome, "targets"))).toBe(false);
      expect(fs.existsSync(path.join(repoPath, ".agent-readiness"))).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      if (originalKey) {
        process.env.MINIMAX_API_KEY = originalKey;
      } else {
        delete process.env.MINIMAX_API_KEY;
      }
    }
  });

  it("records preparation failure in shared history without an artifact", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    try {
      const result = await runSweepWorkflow(path.join(process.env.AGENT_OPS_HOME, "missing"));
      expect(result.status).toBe("failed");
      expect(result.repoPath).toBeUndefined();
      expect(result.workspace).toBeUndefined();
      expect(result.target.commitSha).toBeUndefined();
      expect(result.reportPath).toBeUndefined();
      const reader = openHistoryReader()!;
      try {
        const interaction = reader.listInteractions()[0]!;
        expect(interaction.status).toBe("failed");
        expect(reader.getRun(result.runId)?.status).toBe("failed");
        expect(reader.listArtifacts(interaction.id)).toEqual([]);
      } finally {
        reader.close();
      }
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("rejects non-HTTPS Git URLs before creating a managed checkout", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const result = await runSweepWorkflow(`file://${repoPath}`);

      expect(result.status).toBe("failed");
      expect(result.target.origin).toBe(`file://${repoPath}`);
      expect(result.target.source).toBe("git-url");
      expect(result.workspace).toBeUndefined();
      expect(result.reportPath).toBeUndefined();
      expect(fs.existsSync(path.join(agentOpsHome, "cache", "git"))).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("adds GitHub context when a local target has a GitHub remote", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    git(["remote", "add", "origin", "https://token:secret@github.com/example/demo.git"], repoPath);

    try {
      const result = await runSweepWorkflow(repoPath, {
        github: {
          token: "github-secret",
          now: () => new Date("2026-09-03T12:00:00.000Z"),
          fetch: (url) =>
            Promise.resolve(new Response(JSON.stringify(githubResponseFor(fetchUrl(url)))))
        }
      });
      const report = fs.readFileSync(result.reportPath!, "utf8");
      const serializedResult = JSON.stringify(result);

      expect(result.status).toBe("skipped");
      expect(result.toolCalls.map((call) => call.name)).toEqual([
        "gather_readiness_evidence",
        "rules_benchmark_catalog",
        "gather_github_evidence"
      ]);
      expect(report).toContain("## GitHub Context");
      expect(report).toContain("https://github.com/example/demo");
      expect(report).not.toContain("token:secret");
      expect(serializedResult).not.toContain("github-secret");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("passes GitHub evidence into the model interpretation path", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    sweepHarnessState.prompts = [];
    const repoPath = gitRepo();
    git(["remote", "add", "origin", "https://github.com/example/demo.git"], repoPath);

    try {
      const result = await runSweepWorkflow(repoPath, {
        github: {
          now: () => new Date("2026-09-03T12:00:00.000Z"),
          fetch: (url) =>
            Promise.resolve(new Response(JSON.stringify(githubResponseFor(fetchUrl(url)))))
        }
      });
      const prompt = sweepHarnessState.prompts.join("\n");
      const report = fs.readFileSync(result.reportPath!, "utf8");

      expect(result.status).toBe("completed");
      expect(prompt).toContain('"github"');
      expect(prompt).toContain("https://github.com/example/demo");
      expect(report).toContain("## GitHub Context");
      expect(report).toContain("Open Pull Requests Sampled: 0");
      expect(result.usage.totalTokens).toBe(30);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("aggregates multiple interpretation turns and records benchmark tool activity", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    let turn = 0;
    sweepHarnessState.complete.mockImplementation(() => {
      turn += 1;
      if (turn === 1) {
        return {
          content: [
            {
              type: "toolCall",
              id: "benchmark-call-1",
              name: "readiness_list_corpus",
              arguments: { kind: "patterns" }
            }
          ],
          stopReason: "toolUse",
          usage: {
            input: 8,
            output: 2,
            totalTokens: 10,
            cost: { total: 0 }
          }
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "## Overall Judgment\n\nReady.\n\n## Agent Rules Benchmark\n\nThe hard-prohibition pattern is relevant to explicit boundaries."
          }
        ],
        stopReason: "stop",
        usage: {
          input: 14,
          output: 6,
          totalTokens: 20,
          cost: { total: 0 }
        }
      };
    });

    const result = await runSweepWorkflow(gitRepo());

    expect(result.status).toBe("completed");
    expect(result.usage).toMatchObject({ requests: 2, totalTokens: 30 });
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "gather_readiness_evidence",
      "rules_benchmark_catalog",
      "readiness_list_corpus"
    ]);
    expect(historySnapshot().models.map((call) => call.totalTokens)).toEqual([10, 20]);
    expect(fs.readFileSync(result.reportPath!, "utf8")).toContain("hard-prohibition pattern");
  });

  it("stops an interpretation that keeps requesting tools after six turns", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    let turn = 0;
    sweepHarnessState.complete.mockImplementation(() => {
      turn += 1;
      return {
        content: [
          {
            type: "toolCall",
            id: `benchmark-call-${turn}`,
            name: "readiness_list_corpus",
            arguments: { kind: "patterns" }
          }
        ],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          totalTokens: 2,
          cost: { total: 0 }
        }
      };
    });

    const result = await runSweepWorkflow(gitRepo());

    expect(turn).toBe(6);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("readiness_interpretation_turn_limit");
    expect(result.reportPath).toBeUndefined();
    expect(result.usage).toMatchObject({ requests: 6, totalTokens: 12 });
    expect(historySnapshot().models).toHaveLength(6);
    expect(result.toolCalls.filter((call) => call.name === "readiness_list_corpus")).toHaveLength(
      6
    );
  });

  it("completes with stale and unavailable benchmark states during a controlled outage", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    const repoPath = gitRepo();
    const fetchedAt = Date.parse("2026-09-24T12:00:00.000Z");
    const live = await runSweepWorkflow(repoPath, {
      benchmark: { now: () => fetchedAt }
    });
    const offlineRequest = vi.fn(() =>
      Promise.reject(new Error("controlled outage"))
    ) as unknown as typeof undiciRequest;

    const stale = await runSweepWorkflow(repoPath, {
      benchmark: {
        now: () => fetchedAt + 3 * 24 * 60 * 60 * 1_000,
        request: offlineRequest
      }
    });
    fs.rmSync(path.join(isolatedHome, "cache", "ossrules"), { recursive: true, force: true });
    const unavailable = await runSweepWorkflow(repoPath, {
      benchmark: { now: () => fetchedAt + 8 * 24 * 60 * 60 * 1_000, request: offlineRequest }
    });

    expect(live).toMatchObject({ status: "completed", benchmark: { status: "live" } });
    expect(stale).toMatchObject({
      status: "completed",
      benchmark: { status: "stale", cacheAgeMs: 3 * 24 * 60 * 60 * 1_000 }
    });
    expect(unavailable).toMatchObject({
      status: "completed",
      benchmark: { status: "unavailable" }
    });
    expect(fs.readFileSync(stale.reportPath!, "utf8")).toContain("Status: `stale`");
    expect(fs.readFileSync(unavailable.reportPath!, "utf8")).toContain("Status: `unavailable`");
  });

  it("degrades optional GitHub evidence instead of hanging the sweep", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    git(["remote", "add", "origin", "https://github.com/example/demo.git"], repoPath);

    try {
      const result = await runSweepWorkflow(repoPath, {
        github: {
          timeoutMs: 1,
          now: () => new Date("2026-09-03T12:00:00.000Z"),
          fetch: () => new Promise<Response>(() => undefined)
        }
      });
      const githubCall = result.toolCalls.find((call) => call.name === "gather_github_evidence");
      const report = fs.readFileSync(result.reportPath!, "utf8");

      expect(result.status).toBe("skipped");
      expect(githubCall?.result).toMatchObject({
        available: false,
        reason: "request_failed"
      });
      expect(report).toContain("Status: unavailable (`request_failed`)");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });
});

describe("sweep failure and ownership boundaries", () => {
  it("retains direct-call source context as metadata without inventing Discord identity", async () => {
    const result = await runSweepWorkflow(gitRepo(), {
      sourceContext: { source: "discord", guildId: "test-guild", channelId: "test-channel" }
    });
    expect(result.status).toBe("skipped");
    const snapshot = historySnapshot();
    expect(snapshot.interaction.source).toBe("cli");
    expect(snapshot.interaction.metadata.text).toContain("test-channel");
    expect(snapshot.runs[0]?.metadata.text).toContain("test-channel");
    expect(snapshot.interaction.incomplete).toBe(false);
  });

  it("commits the request and root run before workspace preparation", async () => {
    const prepare = workspaceTools.prepareWorkspace;
    vi.spyOn(workspaceTools, "prepareWorkspace").mockImplementation((...args) => {
      const snapshot = historySnapshot();
      expect(snapshot.interaction.status).toBe("running");
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.messages[0]?.role).toBe("user");
      return prepare(...args);
    });
    const result = await runSweepWorkflow(gitRepo());
    expect(Value.Check(WorkflowResultSchema, result)).toBe(true);
    const snapshot = historySnapshot();
    expect(snapshot.artifacts).toMatchObject([{ runId: result.runId, path: result.reportPath }]);
    expect(fs.statSync(result.reportPath!).mode & 0o777).toBe(0o600);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.interaction.incomplete).toBe(false);
  });

  it("commits evidence start and failure incrementally, then cleans up", async () => {
    vi.spyOn(readinessEvidence, "gatherReadinessEvidence").mockImplementation(() => {
      expect(historySnapshot().calls).toMatchObject([
        { name: "gather_readiness_evidence", kind: "workflow", status: "running" }
      ]);
      throw new Error("evidence_failed");
    });
    const result = await runSweepWorkflow(gitRepo());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("evidence_failed");
    expect(historySnapshot().calls[0]?.status).toBe("failed");
    expect(fs.existsSync(result.workspace!.path)).toBe(false);
    expect(sweepHarnessState.complete).not.toHaveBeenCalled();
  });

  it("starts a model record before dispatch and records measured usage once", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    sweepHarnessState.complete.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        expect(historySnapshot().models).toMatchObject([
          { status: "running", usageState: "unknown" }
        ]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
      }
    );
    const result = await runSweepWorkflow(gitRepo());
    expect(result.status).toBe("completed");
    expect(historySnapshot().models).toMatchObject([
      { status: "completed", totalTokens: 30, usageState: "known" }
    ]);
    expect(historySnapshot().interaction.incomplete).toBe(false);
  });

  it("keeps absent model usage unknown", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    sweepHarnessState.complete.mockResolvedValueOnce({
      content: [{ type: "text", text: "Ready." }]
    });
    const result = await runSweepWorkflow(gitRepo());
    expect(result.status).toBe("completed");
    expect(result.usage.totalTokens).toBeUndefined();
    expect(result.usage.completeness).toBe("unknown");
    expect(historySnapshot().models).toMatchObject([{ totalTokens: null, usageState: "unknown" }]);
  });

  it.each(["reject", "empty", "provider_error", "timeout"])(
    "records model %s without a placeholder report",
    async (mode) => {
      vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
      let modelSignal: AbortSignal | undefined;
      if (mode === "reject")
        sweepHarnessState.complete.mockRejectedValueOnce(new Error("model_failed"));
      if (mode === "empty") sweepHarnessState.complete.mockResolvedValueOnce({ content: [] });
      if (mode === "provider_error")
        sweepHarnessState.complete.mockResolvedValueOnce({
          content: [],
          stopReason: "error",
          errorMessage: "provider_failed"
        });
      if (mode === "timeout")
        sweepHarnessState.complete.mockImplementationOnce(
          (_input: unknown, options: { signal: AbortSignal }) => {
            modelSignal = options.signal;
            return new Promise(() => {});
          }
        );
      const result = await runSweepWorkflow(gitRepo(), { timeoutMs: 10 });
      expect(result.status).toBe("failed");
      expect(result.reportPath).toBeUndefined();
      expect(Value.Check(WorkflowResultSchema, result)).toBe(true);
      expect(historySnapshot().models[0]?.status).toBe(mode === "empty" ? "completed" : "failed");
      expect(historySnapshot().artifacts).toEqual([]);
      if (mode === "timeout") {
        expect(result.error).toContain("workflow_timeout");
        expect(modelSignal?.aborted).toBe(true);
      }
      expect(fs.existsSync(result.workspace!.path)).toBe(false);
    }
  );

  it("passes cancellation to the provider and retains a cancelled run", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    const controller = new AbortController();
    let modelSignal: AbortSignal | undefined;
    sweepHarnessState.complete.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        modelSignal = options.signal;
        controller.abort();
        return new Promise(() => {});
      }
    );
    const result = await runSweepWorkflow(gitRepo(), { signal: controller.signal });
    expect(modelSignal?.aborted).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(historySnapshot().models[0]?.status).toBe("cancelled");
    expect(historySnapshot().runs[0]?.status).toBe("cancelled");
    expect(fs.existsSync(result.workspace!.path)).toBe(false);
  });

  it("records a pre-cancelled request without preparing a workspace", async () => {
    const prepare = vi.spyOn(workspaceTools, "prepareWorkspace");
    const result = await runSweepWorkflow("missing", { signal: AbortSignal.abort() });
    expect(result.status).toBe("cancelled");
    expect(prepare).not.toHaveBeenCalled();
    expect(historySnapshot().interaction.status).toBe("cancelled");
  });

  it("does not register an unwritten report", async () => {
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      if (String(file).endsWith("readiness-sweep.md")) throw new Error("report_write_failed");
      return write(file, ...args);
    });
    const result = await runSweepWorkflow(gitRepo());
    expect(result.status).toBe("failed");
    expect(result.error).toBe("report_write_failed");
    expect(result.reportPath).toBeUndefined();
    expect(historySnapshot().artifacts).toEqual([]);
    expect(fs.existsSync(result.workspace!.path)).toBe(false);
  });

  it.each([false, true])("keeps cleanup failure separate, earlier failure=%s", async (primary) => {
    const prepare = workspaceTools.prepareWorkspace;
    vi.spyOn(workspaceTools, "prepareWorkspace").mockImplementation(async (...args) => {
      const lease = await prepare(...args);
      return {
        ...lease,
        cleanup: async () => {
          await lease.cleanup();
          throw new Error("cleanup_failed");
        }
      };
    });
    if (primary)
      vi.spyOn(readinessEvidence, "gatherReadinessEvidence").mockImplementation(() => {
        throw new Error("evidence_failed");
      });
    const result = await runSweepWorkflow(gitRepo());
    expect(result.status).toBe("failed");
    expect(result.error).toBe(primary ? "evidence_failed" : "cleanup_failed");
    expect(result.cleanupError).toBe("cleanup_failed");
    expect(historySnapshot().runs[0]?.error?.text).toContain("cleanup_failed");
  });

  it("sanitizes raw clone errors before returning or recording them", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-provider-key");
    vi.spyOn(workspaceTools, "prepareWorkspace").mockImplementation(() => {
      const error = new Error(
        "Command failed: git clone https://user:synthetic-secret@example.com/repo.git synthetic-provider-key"
      );
      Object.assign(error, { stdout: "synthetic-secret", stderr: "synthetic-secret" });
      throw error;
    });
    const result = await runSweepWorkflow("https://user:synthetic-secret@example.com/repo.git");
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-provider-key");
    expect(JSON.stringify(historySnapshot())).not.toContain("synthetic-secret");
  });

  it("refuses preparation if acceptance cannot be stored", async () => {
    fs.writeFileSync(path.join(isolatedHome, "history"), "blocked");
    const prepare = vi.spyOn(workspaceTools, "prepareWorkspace");
    await expect(runSweepWorkflow("missing")).rejects.toThrow("history_recording_failed");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("stops after failed evidence persistence and still cleans the checkout", async () => {
    const recording = beginInteraction({
      source: "cli",
      kind: "readiness_sweep",
      userMessage: "sweep"
    });
    const sqlite = new Database(historyDatabasePath());
    sqlite.exec(
      "CREATE TRIGGER fail_tool_finish BEFORE UPDATE ON tool_call BEGIN SELECT RAISE(FAIL, 'injected'); END"
    );
    let workspacePath = "";
    try {
      await expect(
        runSweepWorkflow(gitRepo(), {
          recording,
          onProgress: (event) => {
            if (event.type === "workspace_prepared") workspacePath = event.workspace.path;
          }
        })
      ).rejects.toThrow("history_recording_failed");
      expect(sweepHarnessState.complete).not.toHaveBeenCalled();
      expect(fs.existsSync(workspacePath)).toBe(false);
      expect(historySnapshot().artifacts).toEqual([]);
    } finally {
      sqlite.exec("DROP TRIGGER fail_tool_finish");
      sqlite.close();
      recording.close();
    }
  });

  it("uses a supplied recording as the current run, leaving interaction finalization to its owner", async () => {
    const recording = beginInteraction({
      source: "cli",
      kind: "readiness_sweep",
      userMessage: "sweep"
    });
    try {
      const result = await runSweepWorkflow(gitRepo(), { recording });
      expect(result.runId).toBe(recording.runId);
      expect(historySnapshot().runs).toHaveLength(1);
      expect(historySnapshot().interaction.status).toBe("running");
      recording.appendMessage({ role: "assistant", content: "Canonical summary" });
      recording.finishInteraction({ status: result.status });
    } finally {
      recording.close();
    }
  });

  it("links the plugin child to its capability call and keeps leaf model accounting", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-key");
    const recording = beginInteraction({
      source: "discord",
      applicationId: "test-app",
      sourceMessageId: "test-message",
      kind: "chat",
      userMessage: "sweep"
    });
    try {
      const id = recording.modelStart({ provider: "minimax", model: "router" });
      recording.modelFinish({
        id,
        status: "completed",
        usage: { inputTokens: 2, outputTokens: 3 }
      });
      await readinessTools
        .find((tool) => tool.name === "run_sweep")!
        .execute({ repo_path: gitRepo() }, { surface: "cli", recording });
      const snapshot = historySnapshot();
      expect(snapshot.runs).toHaveLength(2);
      const child = snapshot.runs.find((run) => run.parentRunId === recording.runId)!;
      const capability = snapshot.calls.find((call) => call.runId === recording.runId)!;
      expect(capability.kind).toBe("capability");
      expect(child.triggeringToolCallId).toBe(capability.id);
      expect(child.status).toBe("completed");
      expect(
        snapshot.calls
          .filter((call) => call.runId === child.id)
          .every((call) => call.kind === "workflow")
      ).toBe(true);
      expect(snapshot.models.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0)).toBe(35);
      expect(snapshot.artifacts[0]?.runId).toBe(child.id);
      recording.assertHealthy();
      recording.finishInteraction({ status: "completed" });
    } finally {
      recording.close();
    }
  });
});

function historySnapshot() {
  const reader = openHistoryReader()!;
  try {
    const interaction = reader.listInteractions()[0]!;
    const runs = reader.listRuns(interaction.id);
    return {
      interaction,
      runs,
      messages: reader.listMessages(interaction.id),
      calls: runs.flatMap((run) => reader.listToolCalls(run.id)),
      models: runs.flatMap((run) => reader.listModelCalls(run.id)),
      artifacts: reader.listArtifacts(interaction.id)
    };
  } finally {
    reader.close();
  }
}

function gitRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
  git(["init"], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "Initial commit"], repoPath);
  return repoPath;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function githubResponseFor(url: string): unknown {
  if (url.endsWith("/actions/runs?per_page=5")) {
    return {
      workflow_runs: [
        {
          name: "CI",
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/example/demo/actions/runs/1",
          updated_at: "2026-09-03T11:00:00Z"
        }
      ]
    };
  }
  if (url.endsWith("/pulls?state=open&per_page=5")) return [];
  if (url.endsWith("/issues?state=open&per_page=20")) return [];
  if (url.endsWith("/releases?per_page=3")) return [];
  return {
    full_name: "example/demo",
    html_url: "https://github.com/example/demo",
    description: "Demo repository",
    default_branch: "main",
    visibility: "public",
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    topics: ["agents"],
    stargazers_count: 12,
    open_issues_count: 0,
    pushed_at: "2026-09-03T11:00:00Z",
    updated_at: "2026-09-03T11:00:00Z"
  };
}

function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
