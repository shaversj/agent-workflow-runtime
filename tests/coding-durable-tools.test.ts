import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, vi } from "vitest";

import { openHistoryReader } from "../src/db/index.js";
import {
  checkpointedCodingExtension,
  CodingCandidateDoc,
  checkpointDurableCodingProposal,
  dockerCheckpointedWorkerRuntime,
  initializeCodingCandidate,
  runDurableCodingVerification,
  runDurableCodingTurn,
  validateDurableCodingExecution
} from "../src/harness/coding-durable.js";
import { beginInteraction } from "../src/harness/interaction.js";
import { checkpointCandidate, restoreCandidate } from "../src/plugins/coding/proposal.js";
import type { SourceFile } from "../src/plugins/coding/schemas.js";
import type { DockerWorker } from "../src/workspaces/docker.js";
import { assistantMessage, assistantStream } from "./helpers/pi-model.js";

interface DurableHookTransaction {
  doc(token: { definition: { kind: string } }): Promise<Record<string, unknown>>;
}

interface DurableHookConversation {
  id: number;
  commit(
    change: (transaction: DurableHookTransaction) => Promise<void>,
    context: typeof BACKGROUND_CONTEXT
  ): Promise<void>;
}

function durableHookControl(documents: Record<string, Record<string, unknown>>) {
  const conversation: DurableHookConversation = {
    id: 1,
    async commit(change) {
      await change({
        doc(token) {
          return Promise.resolve(structuredClone(documents[token.definition.kind] ?? {}));
        }
      });
    }
  };
  return {
    conversation,
    control: {
      conversation: () => conversation,
      recording: { assertHealthy: vi.fn() },
      policy: { maxModelCalls: 2, maxTokens: 10_000 },
      model: "MiniMax-M3",
      instructions: "Test durable boundaries."
    }
  };
}

function durableHooks(documents: Record<string, Record<string, unknown>>) {
  const { control } = durableHookControl(documents);
  const extension = checkpointedCodingExtension(
    {
      baseline: [],
      profile: {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: [],
        ignore: [],
        principal: "cli:test"
      },
      assertOwned: vi.fn(),
      execute: vi.fn()
    },
    control as Parameters<typeof checkpointedCodingExtension>[1]
  );
  const generation = extension.hooks?.find(({ task }) => task === "pi.generation")?.handlers as
    | {
        beforeRequest(
          request: { messages: [] },
          api: { taskId: number },
          context: typeof BACKGROUND_CONTEXT
        ): Promise<unknown>;
      }
    | undefined;
  const tool = extension.hooks?.find(({ task }) => task === "pi.tool")?.handlers as
    | {
        beforeTool(
          call: Record<string, never>,
          api: { taskId: number },
          context: typeof BACKGROUND_CONTEXT
        ): Promise<unknown>;
      }
    | undefined;
  if (!generation || !tool) throw new Error("coding_hooks_missing");
  return { generation, tool };
}

describe("checkpointed durable coding tools", () => {
  it("closes every acquired durable harness on success, failure, and cancellation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-lifecycle-"));
    const originalOpen = Harness.open.bind(Harness);
    let closed = 0;
    let abortOnOpen: AbortController | undefined;
    const open = vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
      const harness = await originalOpen(...args);
      const originalClose = harness.close.bind(harness);
      vi.spyOn(harness, "close").mockImplementation(async (...closeArgs) => {
        ++closed;
        await originalClose(...closeArgs);
      });
      abortOnOpen?.abort(new Error("coding_cancelled"));
      return harness;
    });
    try {
      await validateDurableCodingExecution(
        path.join(home, "success.sqlite"),
        new AbortController().signal
      );
      await expect(
        checkpointDurableCodingProposal({
          databasePath: path.join(home, "failure.sqlite"),
          proposal: {} as never,
          signal: new AbortController().signal,
          assertOwned: vi.fn()
        })
      ).rejects.toThrow("invalid_coding_contract");
      abortOnOpen = new AbortController();
      await expect(
        checkpointDurableCodingProposal({
          databasePath: path.join(home, "cancelled.sqlite"),
          proposal: {} as never,
          signal: abortOnOpen.signal,
          assertOwned: vi.fn()
        })
      ).rejects.toThrow();
      expect(closed).toBe(3);
    } finally {
      open.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects malformed durable model reservations before reserving budget", async () => {
    const { generation } = durableHooks({
      "agent-ops.coding-model-reservation": {
        reserved: "yes",
        tokenBound: null,
        reconciled: false
      }
    });

    await expect(
      generation.beforeRequest({ messages: [] }, { taskId: 1 }, BACKGROUND_CONTEXT)
    ).rejects.toThrow("invalid_coding_contract");
  });

  it("rejects malformed durable budgets before model and tool accounting", async () => {
    const documents = {
      "agent-ops.coding-model-reservation": {
        reserved: false,
        tokenBound: null,
        reconciled: false
      },
      "agent-ops.coding-tool-reservation": { reserved: false },
      "agent-ops.coding-budget": {
        modelCalls: -1,
        tokens: 0,
        toolCalls: 0,
        repairAttempts: 0,
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      }
    };
    const { generation, tool } = durableHooks(documents);

    await expect(
      generation.beforeRequest({ messages: [] }, { taskId: 1 }, BACKGROUND_CONTEXT)
    ).rejects.toThrow("invalid_coding_contract");
    await expect(tool.beforeTool({}, { taskId: 2 }, BACKGROUND_CONTEXT)).rejects.toThrow(
      "invalid_coding_contract"
    );
  });

  it("rejects malformed durable tool reservations before reserving budget", async () => {
    const { tool } = durableHooks({
      "agent-ops.coding-tool-reservation": { reserved: 1 }
    });

    await expect(tool.beforeTool({}, { taskId: 1 }, BACKGROUND_CONTEXT)).rejects.toThrow(
      "invalid_coding_contract"
    );
  });

  it("reuses committed verification results after reopening the execution store", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-verification-"));
    const databasePath = path.join(home, "execution.sqlite");
    const baseline: SourceFile[] = [{ path: "app.js", content: "old\n", mode: "100644" }];
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test"
    };
    const candidate = checkpointCandidate(
      profile,
      baseline,
      [{ path: "app.js", content: "new\n", mode: "100644" }],
      1
    );
    const command = vi.fn().mockResolvedValue({
      command: "node --test",
      exitCode: 0,
      output: "passed",
      truncated: false
    });
    const start = vi.fn<typeof DockerWorker.start>((workerProfile) =>
      Promise.resolve({
        id: "verify-worker",
        profile: workerProfile,
        importFiles: () => Promise.resolve(),
        freeze: () => Promise.resolve(),
        snapshot: () => Promise.resolve([{ path: "app.js", content: "new\n", mode: "100644" }]),
        command,
        close: () => Promise.resolve()
      } as unknown as DockerWorker)
    );
    const recording = beginInteraction(
      { source: "cli", kind: "code", userMessage: "Verify" },
      { home }
    );
    const options = {
      databasePath,
      baseline,
      candidate,
      profile,
      jobId: "job-1",
      fence: 1,
      recording,
      signal: new AbortController().signal,
      assertOwned: vi.fn(),
      start
    };
    try {
      await expect(runDurableCodingVerification(options)).resolves.toMatchObject([
        { command: "node --test", exitCode: 0 }
      ]);
      await expect(runDurableCodingVerification(options)).resolves.toMatchObject([
        { command: "node --test", exitCode: 0 }
      ]);
      expect(start).toHaveBeenCalledOnce();
      expect(command).toHaveBeenCalledOnce();
    } finally {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rebuilds every operation in a fresh fence-labelled worker", async () => {
    const baseline: SourceFile[] = [{ path: "app.js", content: "old\n", mode: "100644" }];
    const closeWorkers = [vi.fn(), vi.fn()];
    const workers = ["worker-1", "worker-2"].map((id, index) => ({
      id,
      importFiles: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(baseline),
      close: closeWorkers[index],
      rpc: vi.fn()
    })) as unknown as DockerWorker[];
    const start = vi
      .fn<typeof DockerWorker.start>()
      .mockResolvedValueOnce(workers[0]!)
      .mockResolvedValueOnce(workers[1]!);
    const assertOwned = vi.fn();
    const runtime = dockerCheckpointedWorkerRuntime({
      baseline,
      profile: {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal: "cli:test"
      },
      jobId: "job-1",
      fence: 7,
      assertOwned,
      start
    });
    const signal = new AbortController().signal;
    await runtime.execute(baseline, (worker) => Promise.resolve(worker.id), signal);
    await runtime.execute(baseline, (worker) => Promise.resolve(worker.id), signal);
    expect(start).toHaveBeenNthCalledWith(1, runtime.profile, signal, "job-1", false, 7);
    expect(start).toHaveBeenNthCalledWith(2, runtime.profile, signal, "job-1", false, 7);
    expect(closeWorkers[0]).toHaveBeenCalledOnce();
    expect(closeWorkers[1]).toHaveBeenCalledOnce();
    expect(assertOwned).toHaveBeenCalledTimes(6);
  });

  it("commits write, edit, and shell changes as one restorable candidate sequence", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-tools-"));
    const databasePath = path.join(home, "execution.sqlite");
    const baseline: SourceFile[] = [
      { path: "app.js", content: "const value = 1;\n", mode: "100644" },
      { path: "old.js", content: "remove\n", mode: "100644" }
    ];
    const execute = vi.fn(
      async <T>(
        candidate: SourceFile[],
        operation: (worker: DockerWorker, signal: AbortSignal) => Promise<T>
      ) => {
        const files = new Map(candidate.map((file) => [file.path, { ...file }]));
        const worker = {
          rpc: (op: string, file: string, content?: string) => {
            if (op === "read") {
              const found = files.get(file);
              if (!found) throw new Error("missing");
              return Promise.resolve(found.content);
            }
            if (op === "write") {
              files.set(file, { path: file, content: content!, mode: "100644" });
              return Promise.resolve(true);
            }
            return Promise.reject(new Error("unsupported"));
          },
          command: (command: string) => {
            if (command === "rm old.js") files.delete("old.js");
            return Promise.resolve({ command, exitCode: 0, output: "", truncated: false });
          }
        } as unknown as DockerWorker;
        const result = await operation(worker, new AbortController().signal);
        return {
          result,
          candidate: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))
        };
      }
    );
    const extension = checkpointedCodingExtension({
      baseline,
      profile: {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal: "cli:test"
      },
      assertOwned: vi.fn(),
      execute
    });
    const registry = createRegistry();
    registry.install(extension);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", () =>
      Promise.resolve({ type: "api_key" as const, key: "test-only" })
    );
    const models = createModels({ credentials });
    const provider = minimaxProvider();
    let modelCalls = 0;
    models.setProvider({
      ...provider,
      streamSimple(model) {
        ++modelCalls;
        const toolTurn = modelCalls === 1;
        const message = assistantMessage(model, {
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "write",
                  name: "write_file",
                  arguments: { path: "new.js", content: "export const added = true;\n" }
                },
                {
                  type: "toolCall",
                  id: "edit",
                  name: "edit_file",
                  arguments: { path: "app.js", oldText: "value = 1", newText: "value = 2" }
                },
                {
                  type: "toolCall",
                  id: "shell",
                  name: "bash",
                  arguments: { command: "rm old.js" }
                }
              ]
            : [{ type: "text", text: "complete" }],
          stopReason: toolTurn ? "toolUse" : "stop"
        });
        return assistantStream(message);
      }
    });
    const harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: "minimax", modelId: "MiniMax-M3" },
          extensions: [extension],
          tools: extension.tools
        }
      });
      await initializeCodingCandidate(root, baseline, BACKGROUND_CONTEXT);
      const submission = await root.submit(
        { type: "input", content: "Apply all three changes." },
        BACKGROUND_CONTEXT
      );
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
      expect(execute).toHaveBeenCalledTimes(3);
      const delta = await harness.snapshot(CodingCandidateDoc, root.id, BACKGROUND_CONTEXT);
      expect(delta.revision).toBe(3);
      expect(restoreCandidate(baseline, delta)).toEqual([
        { path: "app.js", content: "const value = 2;\n", mode: "100644" },
        { path: "new.js", content: "export const added = true;\n", mode: "100644" }
      ]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reopens one execution database without replaying an accepted request or mutation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-reopen-"));
    const databasePath = path.join(home, "execution.sqlite");
    const baseline: SourceFile[] = [
      { path: "app.js", content: "const value = 1;\n", mode: "100644" }
    ];
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test"
    };
    const provider = minimaxProvider();
    let modelCalls = 0;
    const modelsForTurn = async () => {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("minimax", () =>
        Promise.resolve({ type: "api_key" as const, key: "test-only" })
      );
      const models = createModels({ credentials });
      models.setProvider({
        ...provider,
        streamSimple(model) {
          const toolTurn = modelCalls++ === 0;
          const message = assistantMessage(model, {
            content: toolTurn
              ? [
                  {
                    type: "toolCall",
                    id: "edit-once",
                    name: "edit_file",
                    arguments: { path: "app.js", oldText: "value = 1", newText: "value = 2" }
                  }
                ]
              : [{ type: "text", text: "Changed the value once." }],
            stopReason: toolTurn ? "toolUse" : "stop"
          });
          return assistantStream(message);
        }
      });
      return models;
    };
    const starts: SourceFile[][] = [];
    const start = vi.fn<typeof DockerWorker.start>((workerProfile) => {
      let files: SourceFile[] = [];
      return Promise.resolve({
        id: `worker-${starts.length + 1}`,
        profile: workerProfile,
        importFiles: (candidate: SourceFile[]) => {
          files = structuredClone(candidate);
          starts.push(files);
          return Promise.resolve();
        },
        snapshot: () => Promise.resolve(structuredClone(files)),
        close: () => Promise.resolve(),
        rpc: (operation: string, file: string, content?: string) => {
          const current = files.find((entry) => entry.path === file);
          if (operation === "read" && current) return Promise.resolve(current.content);
          if (operation === "write" && current) {
            current.content = content!;
            return Promise.resolve(true);
          }
          return Promise.reject(new Error("unexpected_fake_worker_operation"));
        }
      } as unknown as DockerWorker);
    });
    const recording = beginInteraction(
      { source: "cli", kind: "code", userMessage: "Change the value" },
      { home }
    );
    const signal = new AbortController().signal;
    const options = {
      databasePath,
      baseline,
      profile,
      jobId: "job-reopen",
      fence: 1,
      task: "Change the value",
      instructions: "Edit only app.js.",
      requestId: "initial",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      policy: { maxModelCalls: 3, maxTokens: 100_000 },
      model: "MiniMax-M3",
      recording,
      signal,
      assertOwned: vi.fn(),
      start,
      models: await modelsForTurn()
    };
    try {
      const first = await runDurableCodingTurn(options);
      const reopened = await runDurableCodingTurn({ ...options, models: await modelsForTurn() });
      expect(reopened).toEqual(first);
      expect(modelCalls).toBe(2);
      expect(start).toHaveBeenCalledOnce();
      expect(restoreCandidate(baseline, reopened.candidate)).toEqual([
        { path: "app.js", content: "const value = 2;\n", mode: "100644" }
      ]);
    } finally {
      recording.finishRun({ status: "completed" });
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records bounded read metadata in shared history instead of the candidate snapshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-read-audit-"));
    const databasePath = path.join(home, "execution.sqlite");
    const sourceMarker = "unchanged-source-must-not-enter-shared-history";
    const baseline: SourceFile[] = [
      { path: "app.js", content: `${sourceMarker}\n`, mode: "100644" }
    ];
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test"
    };
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", () =>
      Promise.resolve({ type: "api_key" as const, key: "test-only" })
    );
    const models = createModels({ credentials });
    const provider = minimaxProvider();
    let modelCalls = 0;
    models.setProvider({
      ...provider,
      streamSimple(model) {
        const toolTurn = modelCalls++ === 0;
        const message = assistantMessage(model, {
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "read-once",
                  name: "read_file",
                  arguments: { path: "app.js" }
                }
              ]
            : [{ type: "text", text: "Read the requested file." }],
          stopReason: toolTurn ? "toolUse" : "stop"
        });
        return assistantStream(message);
      }
    });
    const start = vi.fn<typeof DockerWorker.start>((workerProfile) => {
      let files: SourceFile[] = [];
      return Promise.resolve({
        id: "read-worker",
        profile: workerProfile,
        importFiles: (candidate: SourceFile[]) => {
          files = structuredClone(candidate);
          return Promise.resolve();
        },
        snapshot: () => Promise.resolve(structuredClone(files)),
        close: () => Promise.resolve(),
        rpc: (operation: string, file: string) => {
          const current = files.find((entry) => entry.path === file);
          if (operation === "read" && current) return Promise.resolve(current.content);
          return Promise.reject(new Error("unexpected_fake_worker_operation"));
        }
      } as unknown as DockerWorker);
    });
    const recording = beginInteraction(
      { source: "cli", kind: "code", userMessage: "Read app.js" },
      { home }
    );
    try {
      await runDurableCodingTurn({
        databasePath,
        baseline,
        profile,
        jobId: "job-read-audit",
        fence: 1,
        task: "Read app.js",
        instructions: "Inspect app.js and stop.",
        requestId: "initial",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        policy: { maxModelCalls: 3, maxTokens: 100_000 },
        model: "MiniMax-M3",
        recording,
        signal: new AbortController().signal,
        assertOwned: vi.fn(),
        start,
        models
      });
      recording.finishRun({ status: "completed" });
      recording.close();

      const reader = openHistoryReader({ home })!;
      try {
        const call = reader.listToolCalls(recording.runId).find(({ name }) => name === "read_file");
        expect(call).toBeDefined();
        expect(call!.result!.text).not.toContain(sourceMarker);
        expect(call!.result!.text).not.toContain("candidate");
        expect(JSON.parse(call!.result!.text)).toEqual({
          path: "app.js",
          bytes: Buffer.byteLength(`${sourceMarker}\n`)
        });
      } finally {
        reader.close();
      }
    } finally {
      recording.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
