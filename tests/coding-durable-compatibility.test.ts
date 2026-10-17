import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createAssistantMessageEventStream,
  createModels,
  InMemoryCredentialStore
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  hook,
  ToolTask
} from "@earendil-works/pi-durable";
import type { Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
  CODING_PI_VERSION,
  codingProfileFingerprint,
  protectDurableProvider
} from "../src/harness/coding-runtime.js";

const PackageManifestSchema = Type.Object({
  dependencies: Type.Record(Type.String(), Type.String())
});

const piRuntimePackages = [
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-durable"
] as const;

const CompatibilityState = defineDoc<{ count: number }>({
  kind: "agent-ops.coding-compatibility",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0 })
});

const CompatibilityBudget = defineDoc<{
  modelCalls: number;
  reservedTokens: number;
  toolCalls: number;
}>({
  kind: "agent-ops.coding-compatibility-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ modelCalls: 0, reservedTokens: 0, toolCalls: 0 })
});

const testCredential = () => Promise.resolve({ type: "api_key" as const, key: "test-only" });

describe("Pi Durable compatibility", () => {
  it("pins the complete Pi runtime family to the durable protocol version", () => {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
    );
    expect(Value.Check(PackageManifestSchema, manifest)).toBe(true);
    if (!Value.Check(PackageManifestSchema, manifest)) throw new Error("package_manifest_invalid");

    for (const packageName of piRuntimePackages) {
      expect(manifest.dependencies[packageName], packageName).toBe(CODING_PI_VERSION);
    }
  });

  it("binds resumable work to its model and durable budgets", () => {
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test"
    };
    const policy = { model: "MiniMax-M3", maxModelCalls: 3, maxTokens: 100_000 };
    const expected = codingProfileFingerprint(profile, policy);
    expect(codingProfileFingerprint(profile, { ...policy, model: "another-model" })).not.toBe(
      expected
    );
    expect(codingProfileFingerprint(profile, { ...policy, maxModelCalls: 4 })).not.toBe(expected);
    expect(codingProfileFingerprint(profile, { ...policy, maxTokens: 100_001 })).not.toBe(expected);
    expect(codingProfileFingerprint(profile, { ...policy, maxRepairAttempts: 0 })).not.toBe(
      expected
    );
  });

  it("persists custom conversation state across a SQLite reopen", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const models = createModels();
    const registry = createRegistry();

    const first = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await first.root(BACKGROUND_CONTEXT);
      await root.commit(async (transaction) => {
        (await transaction.doc(CompatibilityState, root.id)).count = 1;
      }, BACKGROUND_CONTEXT);
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }

    const reopened = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await reopened.root(BACKGROUND_CONTEXT);
      await expect(
        reopened.snapshot(CompatibilityState, root.id, BACKGROUND_CONTEXT)
      ).resolves.toEqual({ count: 1 });
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("deduplicates a replay-safe TypeBox tool and preserves usage across reopen", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", testCredential);
    const models = createModels({ credentials });
    let modelCalls = 0;
    const provider = minimaxProvider();
    models.setProvider({
      ...provider,
      streamSimple(model) {
        ++modelCalls;
        const toolTurn = modelCalls === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "compatibility-call",
                  name: "compatibility_echo",
                  arguments: { value: "durable" }
                }
              ]
            : [{ type: "text", text: "complete" }],
          stopReason: toolTurn ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 5,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 8,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: toolTurn ? "toolUse" : "stop",
          message
        });
        return stream;
      }
    });

    let toolCalls = 0;
    let beforeTools = 0;
    let afterTools = 0;
    const Echo = defineTool({
      name: "compatibility_echo",
      description: "Echo one compatibility value.",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      execute: ({ value }) => {
        ++toolCalls;
        return Promise.resolve({
          output: [{ type: "text" as const, text: value }],
          usage: { input: 0, output: 0, totalTokens: 1, cost: 0 }
        });
      }
    });
    const Compatibility = defineExtension({
      name: "agent-ops-compatibility",
      tools: [Echo],
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            ++beforeTools;
          },
          afterTool: () => {
            ++afterTools;
          }
        })
      ]
    });
    const registry = createRegistry();
    registry.install(Compatibility);

    const first = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    let submissionId: string;
    try {
      const root = await first.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: "minimax", modelId: "MiniMax-M3" },
          extensions: [Compatibility],
          tools: [Echo]
        }
      });
      const submission = await root.submit(
        { type: "input", content: "Run the compatibility tool.", requestId: "compatibility" },
        BACKGROUND_CONTEXT
      );
      submissionId = submission.id;
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({
        status: "done",
        type: "input"
      });
      expect(await first.usage(BACKGROUND_CONTEXT)).toMatchObject({
        models: { "minimax/MiniMax-M3": { totalTokens: 16 } }
      });
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }

    const reopened = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await reopened.root(BACKGROUND_CONTEXT);
      const repeated = await root.submit(
        { type: "input", content: "Run the compatibility tool.", requestId: "compatibility" },
        BACKGROUND_CONTEXT
      );
      expect(repeated.id).toBe(submissionId!);
      await expect(repeated.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
      expect(toolCalls).toBe(1);
      expect(beforeTools).toBe(1);
      expect(afterTools).toBe(1);
      expect(modelCalls).toBe(2);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  const sensitiveContents: AssistantMessage["content"][] = [
    [{ type: "text", text: "password=synthetic-durable-secret" }],
    [
      {
        type: "toolCall",
        id: "sensitive-call",
        name: "compatibility_echo",
        arguments: { password: "synthetic-durable-secret" }
      }
    ]
  ];
  it.each(sensitiveContents.map((content) => [content] as const))(
    "rejects sensitive model payloads before SQLite persistence",
    async (content) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
      const databasePath = path.join(home, "execution.sqlite");
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("minimax", testCredential);
      const models = createModels({ credentials });
      const provider = minimaxProvider();
      models.setProvider(
        protectDurableProvider({
          ...provider,
          streamSimple(model) {
            const message: AssistantMessage = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [...content],
              stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
              timestamp: Date.now(),
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              }
            };
            const stream = createAssistantMessageEventStream();
            stream.push({
              type: "done",
              reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
              message
            });
            return stream;
          }
        })
      );

      const harness = await Harness.open(
        await openNodeSqliteStorage(databasePath),
        { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } },
        BACKGROUND_CONTEXT
      );
      try {
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: { provider: "minimax", modelId: "MiniMax-M3" } }
        });
        const submission = await root.submit(
          { type: "input", content: "Return the sensitive fixture." },
          BACKGROUND_CONTEXT
        );
        await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({
          status: "unanswered"
        });
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }

      expect(fs.readFileSync(databasePath).includes(Buffer.from("synthetic-durable-secret"))).toBe(
        false
      );
      fs.rmSync(home, { recursive: true, force: true });
    }
  );

  it("persists model and token admission before dispatch across reopen", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", testCredential);
    const models = createModels({ credentials });
    let providerCalls = 0;
    let conversation: Conversation;
    const provider = minimaxProvider();
    models.setProvider(
      protectDurableProvider(
        {
          ...provider,
          streamSimple(model) {
            ++providerCalls;
            const message: AssistantMessage = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [{ type: "text", text: "complete" }],
              stopReason: "stop",
              timestamp: Date.now(),
              usage: {
                input: 5,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 8,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              }
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          }
        },
        {
          beforeDispatch: async () => {
            await conversation.commit(async (transaction) => {
              const budget = await transaction.doc(CompatibilityBudget, conversation.id);
              if (budget.modelCalls >= 1 || budget.reservedTokens + 100 > 100) {
                throw new Error("coding_model_budget_exhausted");
              }
              ++budget.modelCalls;
              budget.reservedTokens += 100;
            }, BACKGROUND_CONTEXT);
          }
        }
      )
    );

    const first = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      conversation = await first.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "minimax", modelId: "MiniMax-M3" } }
      });
      const submission = await conversation.submit(
        { type: "input", content: "Complete once." },
        BACKGROUND_CONTEXT
      );
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }

    const reopened = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      conversation = await reopened.root(BACKGROUND_CONTEXT);
      const submission = await conversation.submit(
        { type: "input", content: "Do not dispatch again." },
        BACKGROUND_CONTEXT
      );
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({
        status: "unanswered"
      });
      expect(providerCalls).toBe(1);
      await expect(
        reopened.snapshot(CompatibilityBudget, conversation.id, BACKGROUND_CONTEXT)
      ).resolves.toEqual({ modelCalls: 1, reservedTokens: 100, toolCalls: 0 });
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reuses a committed tool receipt after an interrupted replay-safe execution", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", testCredential);
    const models = createModels({ credentials });
    let modelCalls = 0;
    const provider = minimaxProvider();
    models.setProvider({
      ...provider,
      streamSimple(model) {
        ++modelCalls;
        const toolTurn = modelCalls === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "checkpointed-call",
                  name: "checkpointed_mutation",
                  arguments: { value: "candidate" }
                }
              ]
            : [{ type: "text", text: "complete" }],
          stopReason: toolTurn ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 2,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 4,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: toolTurn ? "toolUse" : "stop",
          message
        });
        return stream;
      }
    });

    let externalMutations = 0;
    let interruptFirstAttempt = true;
    const firstAttemptStarted = Promise.withResolvers<void>();
    const CheckpointedMutation = defineTool({
      name: "checkpointed_mutation",
      description: "Checkpoint one disposable mutation.",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      async execute({ value }, api, context) {
        const receipt = await api.memo<{ value: string }>("receipt", context);
        if (receipt) return { output: [{ type: "text", text: receipt.value }] };
        ++externalMutations;
        await api.memo("receipt", { value }, context);
        if (interruptFirstAttempt) {
          interruptFirstAttempt = false;
          firstAttemptStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            if (!context.abortSignal) throw new Error("compatibility_abort_signal_missing");
            context.abortSignal.addEventListener(
              "abort",
              () => reject(new Error("compatibility_interrupted")),
              { once: true }
            );
          });
        }
        return { output: [{ type: "text", text: value }] };
      }
    });
    const Compatibility = defineExtension({
      name: "agent-ops-checkpoint-compatibility",
      tools: [CheckpointedMutation]
    });
    const registry = createRegistry();
    registry.install(Compatibility);

    const first = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    const root = await first.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: "minimax", modelId: "MiniMax-M3" },
        extensions: [Compatibility],
        tools: [CheckpointedMutation]
      }
    });
    const submission = await root.submit(
      { type: "input", content: "Apply the checkpointed mutation." },
      BACKGROUND_CONTEXT
    );
    const submissionId = submission.id;
    await firstAttemptStarted.promise;
    await first.close(BACKGROUND_CONTEXT);

    const reopened = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      reopened.resume();
      const resumed = await reopened.submission(submissionId, BACKGROUND_CONTEXT);
      expect(resumed).toBeDefined();
      await expect(resumed!.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
      expect(externalMutations).toBe(1);
      expect(modelCalls).toBe(2);
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates conversation cancellation to a running tool", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", testCredential);
    const models = createModels({ credentials });
    const provider = minimaxProvider();
    let modelCalls = 0;
    models.setProvider({
      ...provider,
      streamSimple(model) {
        ++modelCalls;
        const toolTurn = modelCalls === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "blocking-call",
                  name: "blocking_tool",
                  arguments: {}
                }
              ]
            : [{ type: "text", text: "cancelled" }],
          stopReason: toolTurn ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
        return stream;
      }
    });
    const started = Promise.withResolvers<void>();
    let observedAbort = false;
    const BlockingTool = defineTool({
      name: "blocking_tool",
      description: "Wait until cancelled.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute(_args, _api, context) {
        started.resolve();
        while (!context.abortSignal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        observedAbort = true;
        throw new Error("compatibility_cancelled");
      }
    });
    const Compatibility = defineExtension({
      name: "agent-ops-cancellation-compatibility",
      tools: [BlockingTool]
    });
    const registry = createRegistry();
    registry.install(Compatibility);
    const harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: "minimax", modelId: "MiniMax-M3" },
          extensions: [Compatibility],
          tools: [BlockingTool]
        }
      });
      const submission = await root.submit(
        { type: "input", content: "Start the blocking tool." },
        BACKGROUND_CONTEXT
      );
      await started.promise;
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const task = inspection.tasks.find((candidate) => candidate.record.kind === "pi.tool");
      expect(task).toBeDefined();
      await expect(harness.abortTask(task!.record.id, BACKGROUND_CONTEXT)).resolves.toBe("marked");
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
      await vi.waitFor(() => expect(observedAbort).toBe(true));
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("blocks tool execution after its durable call budget is exhausted", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-durable-"));
    const databasePath = path.join(home, "execution.sqlite");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("minimax", testCredential);
    const models = createModels({ credentials });
    const provider = minimaxProvider();
    let modelCalls = 0;
    models.setProvider({
      ...provider,
      streamSimple(model) {
        ++modelCalls;
        const toolTurn = modelCalls === 1;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: toolTurn
            ? [
                {
                  type: "toolCall",
                  id: "budget-call-1",
                  name: "budgeted_tool",
                  arguments: { value: "first" }
                },
                {
                  type: "toolCall",
                  id: "budget-call-2",
                  name: "budgeted_tool",
                  arguments: { value: "second" }
                }
              ]
            : [{ type: "text", text: "complete" }],
          stopReason: toolTurn ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 2,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 4,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
        return stream;
      }
    });
    let externalCalls = 0;
    const BudgetedTool = defineTool({
      name: "budgeted_tool",
      description: "Use one durable tool-call reservation.",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      executionMode: "sequential",
      async execute({ value }, api, context) {
        await api.commit(async (transaction) => {
          const budget = await transaction.doc(CompatibilityBudget, api.conversationId);
          if (budget.toolCalls >= 1) throw new Error("coding_tool_budget_exhausted");
          ++budget.toolCalls;
        }, context);
        ++externalCalls;
        return { output: [{ type: "text", text: value }] };
      }
    });
    const Compatibility = defineExtension({
      name: "agent-ops-tool-budget-compatibility",
      tools: [BudgetedTool]
    });
    const registry = createRegistry();
    registry.install(Compatibility);
    const harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models, registry, settings: { retry: { maxRetries: 0 } } },
      BACKGROUND_CONTEXT
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: "minimax", modelId: "MiniMax-M3" },
          extensions: [Compatibility],
          tools: [BudgetedTool]
        }
      });
      const submission = await root.submit(
        { type: "input", content: "Try both budgeted calls." },
        BACKGROUND_CONTEXT
      );
      await expect(submission.wait(BACKGROUND_CONTEXT)).resolves.toMatchObject({ status: "done" });
      expect(externalCalls).toBe(1);
      await expect(
        harness.snapshot(CompatibilityBudget, root.id, BACKGROUND_CONTEXT)
      ).resolves.toEqual({ modelCalls: 0, reservedTokens: 0, toolCalls: 1 });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
