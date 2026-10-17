import crypto from "node:crypto";

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  section,
  ToolTask
} from "@earendil-works/pi-durable";
import type { Conversation, ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type, type Static } from "typebox";

import type { CodingProfile } from "../workspaces/execution.js";
import { DockerWorker } from "../workspaces/docker.js";
import {
  candidateDeltaDigest,
  checkpointCandidate,
  restoreCandidate,
  sourceManifestDigest
} from "../plugins/coding/proposal.js";
import {
  CandidateDeltaSchema,
  MutationReceiptSchema,
  CodingProposalCheckpointSchema,
  CodingProposalSchema,
  VerificationCheckpointSchema,
  VerificationSchema,
  parseCoding
} from "../plugins/coding/schemas.js";
import type {
  CandidateDelta,
  CodingProposalCheckpoint,
  CodingProposal,
  MutationReceipt,
  SourceFile,
  VerificationCheckpoint
} from "../plugins/coding/schemas.js";
import { redactApplicationText } from "./redaction.js";
import type { InteractionRecorder } from "./interaction.js";
import { assistantText, observedModelUsage } from "./usage.js";
import { protectDurableProvider } from "./coding-runtime.js";

export const CodingCandidateDoc = defineDoc<CandidateDelta>({
  kind: "agent-ops.coding-candidate",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ baselineDigest: "0".repeat(64), files: [], deleted: [], revision: 0 })
});

const CodingMutationReceiptDoc = defineDoc<MutationReceipt>({
  kind: "agent-ops.coding-mutation-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ committed: false })
});

const DurableBudgetStateSchema = Type.Object(
  {
    modelCalls: Type.Integer({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    repairAttempts: Type.Integer({ minimum: 0 }),
    deadlineAt: Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"
    })
  },
  { additionalProperties: false }
);
type DurableBudgetState = Static<typeof DurableBudgetStateSchema> & Record<string, string | number>;

const ModelReservationSchema = Type.Object(
  {
    reserved: Type.Boolean(),
    tokenBound: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    reconciled: Type.Boolean()
  },
  { additionalProperties: false }
);
type ModelReservation = Static<typeof ModelReservationSchema> &
  Record<string, boolean | number | null>;

const ToolReservationSchema = Type.Object(
  { reserved: Type.Boolean() },
  { additionalProperties: false }
);
type ToolReservation = Static<typeof ToolReservationSchema> & Record<string, boolean>;

const CodingBudgetDoc = defineDoc<DurableBudgetState>({
  kind: "agent-ops.coding-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    modelCalls: 0,
    tokens: 0,
    toolCalls: 0,
    repairAttempts: 0,
    deadlineAt: new Date(0).toISOString()
  })
});

const CodingModelReservationDoc = defineDoc<ModelReservation>({
  kind: "agent-ops.coding-model-reservation",
  version: 1,
  scope: "task",
  initial: () => ({ reserved: false, tokenBound: null, reconciled: false })
});

const CodingToolReservationDoc = defineDoc<ToolReservation>({
  kind: "agent-ops.coding-tool-reservation",
  version: 1,
  scope: "task",
  initial: () => ({ reserved: false })
});

const CodingVerificationDoc = defineDoc<VerificationCheckpoint>({
  kind: "agent-ops.coding-verification",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ records: [] })
});

const CodingProposalCheckpointDoc = defineDoc<CodingProposalCheckpoint>({
  kind: "agent-ops.coding-proposal",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({})
});

interface DurableCodingControl {
  conversation: () => Conversation;
  recording: InteractionRecorder;
  policy: { maxModelCalls: number; maxTokens: number };
  model: string;
  instructions: string;
}

interface CheckpointedWorkerRuntime {
  readonly baseline: SourceFile[];
  readonly profile: CodingProfile;
  assertOwned(): void;
  execute<T>(
    candidate: SourceFile[],
    operation: (worker: DockerWorker, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<{ result: T; candidate: SourceFile[] }>;
}

export function dockerCheckpointedWorkerRuntime(options: {
  baseline: SourceFile[];
  profile: CodingProfile;
  jobId: string;
  fence: number;
  assertOwned: () => void;
  start?: typeof DockerWorker.start;
}): CheckpointedWorkerRuntime {
  const start = options.start ?? DockerWorker.start;
  return {
    baseline: options.baseline,
    profile: options.profile,
    assertOwned: options.assertOwned,
    async execute(candidate, operation, signal) {
      options.assertOwned();
      const worker = await start(options.profile, signal, options.jobId, false, options.fence);
      try {
        options.assertOwned();
        await worker.importFiles(candidate);
        const result = await operation(worker, signal);
        options.assertOwned();
        const snapshot = await worker.snapshot();
        return { result, candidate: snapshot };
      } finally {
        await worker.close();
      }
    }
  };
}

export async function initializeCodingCandidate(
  conversation: Conversation,
  baseline: SourceFile[],
  context: Parameters<Conversation["commit"]>[1]
): Promise<CandidateDelta> {
  const initial = parseCoding(CandidateDeltaSchema, {
    baselineDigest: sourceManifestDigest(baseline),
    files: [],
    deleted: [],
    revision: 0
  });
  await conversation.commit(async (transaction) => {
    const candidate = parseCoding(
      CandidateDeltaSchema,
      await transaction.doc(CodingCandidateDoc, conversation.id)
    );
    if (
      candidate.baselineDigest !== "0".repeat(64) &&
      candidate.baselineDigest !== initial.baselineDigest
    )
      throw new Error("coding_baseline_changed");
    if (candidate.baselineDigest === "0".repeat(64)) Object.assign(candidate, initial);
  }, context);
  return initial;
}

interface DurableCodingTurnOptions {
  databasePath: string;
  baseline: SourceFile[];
  profile: CodingProfile;
  jobId: string;
  fence: number;
  task: string;
  instructions: string;
  requestId: string;
  deadlineAt: string;
  policy: { maxModelCalls: number; maxTokens: number; maxRepairAttempts?: number };
  repairAttempt?: number;
  model: string;
  recording: InteractionRecorder;
  signal: AbortSignal;
  assertOwned: () => void;
  start?: typeof DockerWorker.start;
  models?: MutableModels;
  apiKey?: string;
}

export async function validateDurableCodingExecution(
  databasePath: string,
  signal: AbortSignal
): Promise<void> {
  await withCodingHarness(
    databasePath,
    signal,
    { models: createModels(), registry: createRegistry() },
    () => Promise.resolve()
  );
}

interface DurableCodingTurnResult {
  conversationId: number;
  submissionId: number;
  summary: string;
  candidate: CandidateDelta;
}

export async function runDurableCodingTurn(
  options: DurableCodingTurnOptions
): Promise<DurableCodingTurnResult> {
  options.assertOwned();
  const credentials = new InMemoryCredentialStore();
  const models = options.models ?? createModels({ credentials });
  if (!options.models) {
    if (!options.apiKey) throw new Error("coding_model_credential_missing");
    await credentials.modify("minimax", () =>
      Promise.resolve({ type: "api_key" as const, key: options.apiKey! })
    );
    models.setProvider(
      protectDurableProvider(minimaxProvider(), {
        beforeDispatch: () => {
          options.recording.assertHealthy();
          options.assertOwned();
          options.signal.throwIfAborted();
          return Promise.resolve();
        }
      })
    );
  }
  const registry = createRegistry();
  let conversation: Conversation | undefined;
  const runtime = dockerCheckpointedWorkerRuntime({
    baseline: options.baseline,
    profile: options.profile,
    jobId: options.jobId,
    fence: options.fence,
    assertOwned: options.assertOwned,
    ...(options.start ? { start: options.start } : {})
  });
  const extension = checkpointedCodingExtension(runtime, {
    conversation: () => {
      if (!conversation) throw new Error("coding_conversation_unavailable");
      return conversation;
    },
    recording: options.recording,
    policy: options.policy,
    model: options.model,
    instructions: options.instructions
  });
  registry.install(extension);
  return withCodingHarness(
    options.databasePath,
    options.signal,
    {
      models,
      registry,
      settings: {
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: {
          enabled: false,
          reserveTokens: 8192,
          keepRecentTokens: 4096,
          backgroundTokens: 0
        }
      }
    },
    async (harness, context) => {
      const abort = () => {
        if (conversation)
          void conversation.abort(BACKGROUND_CONTEXT, { background: true }).catch(() => {});
      };
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        conversation = await harness.root(context, {
          agent: {
            model: { provider: "minimax", modelId: options.model },
            thinkingLevel: "off",
            extensions: [extension],
            tools: extension.tools,
            modelTools: extension.tools,
            cwd: "/workspace"
          }
        });
        await initializeCodingCandidate(conversation, options.baseline, context);
        await initializeCodingBudget(conversation, options.deadlineAt, context);
        const repairAttempt = options.repairAttempt;
        if (repairAttempt !== undefined) {
          await conversation.commit(async (transaction) => {
            const budget = parseCoding(
              DurableBudgetStateSchema,
              await transaction.doc(CodingBudgetDoc, conversation!.id)
            );
            assertBudgetDeadline(budget);
            const allowed = options.policy.maxRepairAttempts ?? 1;
            if (repairAttempt > allowed || repairAttempt > budget.repairAttempts + 1)
              throw new Error("coding_repair_budget_exhausted");
            budget.repairAttempts = Math.max(budget.repairAttempts, repairAttempt);
          }, context);
        }
        options.assertOwned();
        const submission = await conversation.submit(
          {
            type: "input",
            content: redactApplicationText(options.task).slice(0, 32768),
            requestId: options.requestId
          },
          context
        );
        const settled = await submission.wait(context);
        if (settled.status !== "done") throw new Error("coding_model_failed");
        const view = await conversation.context(context);
        const last = [...view.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
        if (!last || ["error", "aborted", "pending"].includes(last.stopReason))
          throw new Error("coding_model_failed");
        const candidate = parseCoding(
          CandidateDeltaSchema,
          await harness.snapshot(CodingCandidateDoc, conversation.id, context)
        );
        return {
          conversationId: conversation.id,
          submissionId: submission.id,
          summary: redactApplicationText(assistantText(last)).slice(0, 8000),
          candidate
        };
      } finally {
        options.signal.removeEventListener("abort", abort);
      }
    }
  );
}

interface DurableCodingVerificationOptions {
  databasePath: string;
  baseline: SourceFile[];
  candidate: CandidateDelta;
  profile: CodingProfile;
  jobId: string;
  fence: number;
  recording: InteractionRecorder;
  signal: AbortSignal;
  assertOwned: () => void;
  start?: typeof DockerWorker.start;
}

export async function runDurableCodingVerification(
  options: DurableCodingVerificationOptions
): Promise<CodingProposal["checks"]> {
  options.assertOwned();
  const registry = createRegistry();
  return withCodingHarness(
    options.databasePath,
    options.signal,
    { models: createModels(), registry },
    async (harness, context) => {
      const conversation = await harness.root(context);
      await initializeCodingCandidate(conversation, options.baseline, context);
      let storedCandidate = parseCoding(
        CandidateDeltaSchema,
        await harness.snapshot(CodingCandidateDoc, conversation.id, context)
      );
      const requestedCandidateDigest = candidateDeltaDigest(options.candidate);
      if (candidateDeltaDigest(storedCandidate) !== requestedCandidateDigest) {
        const restored = restoreCandidate(options.baseline, options.candidate);
        const validated = checkpointCandidate(
          options.profile,
          options.baseline,
          restored,
          options.candidate.revision
        );
        if (
          candidateDeltaDigest(validated) !== requestedCandidateDigest ||
          storedCandidate.revision > options.candidate.revision
        )
          throw new Error("coding_candidate_conflict");
        await conversation.commit(async (transaction) => {
          options.assertOwned();
          const durable = parseCoding(
            CandidateDeltaSchema,
            await transaction.doc(CodingCandidateDoc, conversation.id)
          );
          if (durable.revision !== storedCandidate.revision)
            throw new Error("coding_candidate_conflict");
          Object.assign(durable, validated);
        }, context);
        storedCandidate = validated;
      }
      const candidate = restoreCandidate(options.baseline, storedCandidate);
      const candidateDigest = candidateDeltaDigest(storedCandidate);
      const checks: CodingProposal["checks"] = [];
      for (const [index, command] of options.profile.requiredChecks.entries()) {
        options.assertOwned();
        options.signal.throwIfAborted();
        const key = crypto
          .createHash("sha256")
          .update(`${candidateDigest}\0${index}\0${command}`)
          .digest("hex");
        const checkpoint = parseCoding(
          VerificationCheckpointSchema,
          (await harness.snapshot(CodingVerificationDoc, conversation.id, context)) ?? {
            records: []
          }
        );
        const existing = checkpoint.records.find((record) => record.key === key);
        if (existing) {
          options.recording.recordTool(
            {
              name: "coding.verify_checkpoint",
              source: "coding",
              kind: "workflow",
              input: { command, candidateDigest }
            },
            () => ({ command, exitCode: existing.check.exitCode, reused: true }),
            options.signal
          );
          checks.push(existing.check);
          continue;
        }
        const check = parseCoding(
          VerificationSchema,
          await options.recording.recordTool(
            { name: "coding.verify", source: "coding", kind: "capability", input: { command } },
            async () => {
              const worker = await (options.start ?? DockerWorker.start)(
                options.profile,
                options.signal,
                options.jobId,
                true,
                options.fence
              );
              try {
                options.assertOwned();
                await worker.importFiles(candidate);
                await worker.freeze();
                const sealed = await worker.snapshot();
                const result = await worker.command(command, options.signal);
                const after = await worker.snapshot();
                if (sourceManifestDigest(sealed) !== sourceManifestDigest(after))
                  throw new Error("coding_verification_mutated_snapshot");
                if (result.command !== command) throw new Error("coding_verification_mismatch");
                const check = parseCoding(VerificationSchema, {
                  ...result,
                  output: redactApplicationText(result.output)
                });
                await conversation.commit(async (transaction) => {
                  options.assertOwned();
                  const durableCandidate = parseCoding(
                    CandidateDeltaSchema,
                    await transaction.doc(CodingCandidateDoc, conversation.id)
                  );
                  if (candidateDeltaDigest(durableCandidate) !== candidateDigest)
                    throw new Error("coding_candidate_conflict");
                  const durable = await transaction.doc(CodingVerificationDoc, conversation.id);
                  const current = parseCoding(VerificationCheckpointSchema, durable);
                  const committed = current.records.find((record) => record.key === key);
                  if (committed) {
                    if (JSON.stringify(committed.check) !== JSON.stringify(check))
                      throw new Error("coding_verification_conflict");
                    return;
                  }
                  Object.assign(
                    durable,
                    parseCoding(VerificationCheckpointSchema, {
                      records: [...current.records, { key, candidateDigest, check }]
                    })
                  );
                }, context);
                return check;
              } finally {
                await worker.close();
              }
            },
            options.signal
          )
        );
        checks.push(check);
      }
      return checks;
    }
  );
}

export async function checkpointDurableCodingProposal(options: {
  databasePath: string;
  proposal: CodingProposal;
  signal: AbortSignal;
  assertOwned: () => void;
}): Promise<CodingProposal> {
  options.assertOwned();
  return withCodingHarness(
    options.databasePath,
    options.signal,
    { models: createModels(), registry: createRegistry() },
    async (harness, context) => {
      const conversation = await harness.root(context);
      const proposal = parseCoding(CodingProposalSchema, options.proposal);
      await conversation.commit(async (transaction) => {
        options.assertOwned();
        const durable = await transaction.doc(CodingProposalCheckpointDoc, conversation.id);
        const checkpoint = parseCoding(CodingProposalCheckpointSchema, durable);
        if (checkpoint.proposal) {
          if (JSON.stringify(checkpoint.proposal) !== JSON.stringify(proposal))
            throw new Error("coding_proposal_conflict");
          return;
        }
        Object.assign(durable, parseCoding(CodingProposalCheckpointSchema, { proposal }));
      }, context);
      return proposal;
    }
  );
}

async function initializeCodingBudget(
  conversation: Conversation,
  deadlineAt: string,
  context: Parameters<Conversation["commit"]>[1]
): Promise<void> {
  await conversation.commit(async (transaction) => {
    const budget = parseCoding(
      DurableBudgetStateSchema,
      await transaction.doc(CodingBudgetDoc, conversation.id)
    );
    if (budget.deadlineAt !== new Date(0).toISOString() && budget.deadlineAt !== deadlineAt)
      throw new Error("coding_budget_conflict");
    budget.deadlineAt = deadlineAt;
  }, context);
}

export function checkpointedCodingExtension(
  runtime: CheckpointedWorkerRuntime,
  control?: DurableCodingControl
) {
  const modelCalls = new Map<number, number>();
  const mutate = <T extends typeof WriteParameters | typeof EditParameters | typeof BashParameters>(
    tool: ToolRegistration<T>,
    operation: (
      args: import("typebox").Static<T>,
      worker: DockerWorker,
      signal: AbortSignal
    ) => Promise<string>
  ) =>
    defineTool({
      ...tool,
      replay: "safe" as const,
      executionMode: "sequential" as const,
      async execute(args, api, context) {
        const signal = context.abortSignal ?? new AbortController().signal;
        const audit = {
          name: tool.name,
          source: "coding",
          kind: "capability" as const,
          input: durableToolAuditInput(tool.name, args)
        };
        const existing = parseCoding(
          MutationReceiptSchema,
          (await api.snapshot(CodingMutationReceiptDoc, api.taskId, context)) ?? {
            committed: false
          }
        );
        if (existing.committed) {
          if (control)
            control.recording.recordTool(
              audit,
              () => ({ tool: tool.name, revision: existing.revision, reused: true }),
              signal
            );
          return { output: [{ type: "text" as const, text: existing.output! }] };
        }
        runtime.assertOwned();
        const current = parseCoding(
          CandidateDeltaSchema,
          await api.snapshot(CodingCandidateDoc, api.conversationId, context)
        );
        const restored = restoreCandidate(runtime.baseline, current);
        let output: string | undefined;
        const run = async () => {
          const executed = await runtime.execute(
            restored,
            (worker, workerSignal) => operation(args, worker, workerSignal),
            signal
          );
          runtime.assertOwned();
          const next = checkpointCandidate(
            runtime.profile,
            runtime.baseline,
            executed.candidate,
            current.revision + 1
          );
          output = redactApplicationText(String(executed.result)).slice(0, 65536);
          const receipt = parseCoding(MutationReceiptSchema, {
            committed: true,
            tool: tool.name,
            output,
            deltaDigest: candidateDeltaDigest(next),
            revision: next.revision
          });
          await api.commit(async (transaction) => {
            runtime.assertOwned();
            const candidate = parseCoding(
              CandidateDeltaSchema,
              await transaction.doc(CodingCandidateDoc, api.conversationId)
            );
            if (candidate.revision !== current.revision)
              throw new Error("coding_candidate_conflict");
            Object.assign(candidate, next);
            const durableReceipt = parseCoding(
              MutationReceiptSchema,
              await transaction.doc(CodingMutationReceiptDoc, api.taskId)
            );
            Object.assign(durableReceipt, receipt);
          }, context);
          return { tool: tool.name, revision: current.revision + 1 };
        };
        if (control) {
          await control.recording.recordTool(audit, run, signal);
        } else await run();
        if (output === undefined) throw new Error("coding_tool_result_missing");
        return { output: [{ type: "text" as const, text: output }] };
      }
    });

  const ReadFile = defineTool({
    name: "read_file",
    description: "Read one UTF-8 file from the current candidate.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) }),
    replay: "safe",
    async execute({ path }, api, context) {
      runtime.assertOwned();
      const delta = parseCoding(
        CandidateDeltaSchema,
        await api.snapshot(CodingCandidateDoc, api.conversationId, context)
      );
      const candidate = restoreCandidate(runtime.baseline, delta);
      const signal = context.abortSignal ?? new AbortController().signal;
      let executed: Awaited<ReturnType<CheckpointedWorkerRuntime["execute"]>> | undefined;
      const run = async () => {
        executed = await runtime.execute(
          candidate,
          async (worker, workerSignal) =>
            String(await worker.rpc("read", path, undefined, workerSignal)),
          signal
        );
        return { path, bytes: Buffer.byteLength(String(executed.result)) };
      };
      if (control) {
        await control.recording.recordTool(
          { name: "read_file", source: "coding", kind: "capability", input: { path } },
          run,
          signal
        );
      } else await run();
      if (!executed) throw new Error("coding_tool_result_missing");
      return {
        output: [
          { type: "text", text: redactApplicationText(String(executed.result)).slice(0, 65536) }
        ]
      };
    }
  });

  const WriteFile = mutate(
    {
      name: "write_file",
      description: "Write one UTF-8 file in the disposable candidate.",
      parameters: WriteParameters,
      execute() {
        return Promise.reject(new Error("unreachable"));
      }
    },
    async ({ path, content }, worker, signal) => {
      await worker.rpc("write", path, content, signal);
      return `Wrote ${path}`;
    }
  );
  const EditFile = mutate(
    {
      name: "edit_file",
      description: "Replace one exact text occurrence in a UTF-8 file.",
      parameters: EditParameters,
      execute() {
        return Promise.reject(new Error("unreachable"));
      }
    },
    async ({ path, oldText, newText }, worker, signal) => {
      const content = String(await worker.rpc("read", path, undefined, signal));
      if (!content.includes(oldText) || content.indexOf(oldText) !== content.lastIndexOf(oldText))
        throw new Error("coding_edit_match_invalid");
      await worker.rpc("write", path, content.replace(oldText, newText), signal);
      return `Edited ${path}`;
    }
  );
  const Bash = mutate(
    {
      name: "bash",
      description: "Run a bounded command in the offline disposable candidate.",
      parameters: BashParameters,
      execute() {
        return Promise.reject(new Error("unreachable"));
      }
    },
    async ({ command }, worker, signal) => {
      const result = await worker.command(command, signal);
      return JSON.stringify(result);
    }
  );

  const hooks = control
    ? [
        hook(GenerationTask, {
          beforeRequest: async ({ messages }, api, context) => {
            control.recording.assertHealthy();
            const tokenBound = Buffer.byteLength(JSON.stringify(messages)) + 8192;
            await control.conversation().commit(async (transaction) => {
              const reservation = parseCoding(
                ModelReservationSchema,
                await transaction.doc(CodingModelReservationDoc, api.taskId)
              );
              if (!reservation.reserved) {
                const budget = parseCoding(
                  DurableBudgetStateSchema,
                  await transaction.doc(CodingBudgetDoc, control.conversation().id)
                );
                assertBudgetDeadline(budget);
                if (
                  budget.modelCalls >= control.policy.maxModelCalls ||
                  budget.tokens + tokenBound >= control.policy.maxTokens
                )
                  throw new Error("coding_model_budget_exhausted");
                ++budget.modelCalls;
                budget.tokens += tokenBound;
                reservation.reserved = true;
                reservation.tokenBound = tokenBound;
              }
            }, context);
            modelCalls.set(
              api.taskId,
              control.recording.modelStart({ provider: "minimax", model: control.model })
            );
            return undefined;
          },
          afterResponse: async (message, api, context) => {
            const usage = observedModelUsage(message);
            if (!usage) throw new Error("coding_usage_unknown");
            await control.conversation().commit(async (transaction) => {
              const reservation = parseCoding(
                ModelReservationSchema,
                await transaction.doc(CodingModelReservationDoc, api.taskId)
              );
              if (!reservation.reconciled) {
                const budget = parseCoding(
                  DurableBudgetStateSchema,
                  await transaction.doc(CodingBudgetDoc, control.conversation().id)
                );
                budget.tokens = Math.max(0, budget.tokens - (reservation.tokenBound ?? 0));
                budget.tokens += usage.totalTokens;
                reservation.reconciled = true;
              }
            }, context);
            const id = modelCalls.get(api.taskId);
            if (id !== undefined) {
              control.recording.modelFinish({
                id,
                status:
                  message.stopReason === "error" || message.stopReason === "aborted"
                    ? "failed"
                    : "completed",
                usage
              });
              modelCalls.delete(api.taskId);
            }
            control.recording.appendMessage({ role: "assistant", content: assistantText(message) });
          }
        }),
        hook(ToolTask, {
          beforeTool: async (_call, api, context) => {
            control.recording.assertHealthy();
            await control.conversation().commit(async (transaction) => {
              const reservation = parseCoding(
                ToolReservationSchema,
                await transaction.doc(CodingToolReservationDoc, api.taskId)
              );
              if (!reservation.reserved) {
                const budget = parseCoding(
                  DurableBudgetStateSchema,
                  await transaction.doc(CodingBudgetDoc, control.conversation().id)
                );
                assertBudgetDeadline(budget);
                if (budget.toolCalls >= 128) throw new Error("coding_tool_budget_exhausted");
                ++budget.toolCalls;
                reservation.reserved = true;
              }
            }, context);
            return undefined;
          }
        })
      ]
    : [];
  return defineExtension({
    name: "agent-ops-coding",
    tools: [ReadFile, WriteFile, EditFile, Bash],
    hooks,
    ...(control
      ? {
          sections: [
            section("coding", () => redactApplicationText(control.instructions).slice(0, 32768))
          ]
        }
      : {})
  });
}

function assertBudgetDeadline(budget: DurableBudgetState): void {
  if (Date.parse(budget.deadlineAt) <= Date.now()) throw new Error("coding_deadline_exceeded");
}

async function withCodingHarness<T>(
  databasePath: string,
  signal: AbortSignal,
  options: Parameters<typeof Harness.open>[1],
  operation: (
    harness: Awaited<ReturnType<typeof Harness.open>>,
    context: Parameters<typeof Harness.open>[2]
  ) => Promise<T>
): Promise<T> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const harness = await Harness.open(await openNodeSqliteStorage(databasePath), options, context);
  try {
    return await operation(harness, context);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

function durableToolAuditInput(name: string, args: object): object {
  if (name === "write_file") {
    const value = args as { path: string; content: string };
    return { path: value.path, bytes: Buffer.byteLength(value.content) };
  }
  if (name === "edit_file") {
    const value = args as { path: string; oldText: string; newText: string };
    return {
      path: value.path,
      oldBytes: Buffer.byteLength(value.oldText),
      newBytes: Buffer.byteLength(value.newText)
    };
  }
  if (name === "bash") {
    const value = args as { command: string };
    return {
      commandDigest: crypto.createHash("sha256").update(value.command).digest("hex")
    };
  }
  return {};
}

const WriteParameters = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Type.String({ maxLength: 1024 * 1024 })
  },
  { additionalProperties: false }
);
const EditParameters = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    oldText: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
    newText: Type.String({ maxLength: 1024 * 1024 })
  },
  { additionalProperties: false }
);
const BashParameters = Type.Object(
  { command: Type.String({ minLength: 1, maxLength: 2048 }) },
  { additionalProperties: false }
);
