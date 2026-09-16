import fs from "node:fs";
import path from "node:path";

import { openHistoryStore } from "../db/index.js";
import type { AcceptedInteraction, HistoryStore, HistoryStoreOptions } from "../db/index.js";
import type { CodingStore } from "../db/coding-store.js";
import { CodingDecisionError } from "../db/coding-store.js";
import { logger } from "../logger.js";
import { agentOpsHome, historyArtifactsPath } from "../workspaces/storage.js";
import type {
  AcceptInteractionInput,
  AppendMessageInput,
  CreateRunInput,
  FinishDeliveryAttemptInput,
  FinishInteractionInput,
  FinishModelCallInput,
  FinishRunInput,
  HistoryOwner,
  RegisterArtifactInput,
  StartDeliveryAttemptInput,
  StartModelCallInput,
  StartToolCallInput,
  TerminalStatus,
  UpdateRunInput
} from "./history-schemas.js";
import { combineAbortSignals } from "./timeout.js";

export interface InteractionOptions extends HistoryStoreOptions {
  signal?: AbortSignal;
}

export type RecordedToolInput = Omit<StartToolCallInput, "runId" | "ordinal" | "parentCallId">;
export type InteractionRecorder = Recorder;

// Reserve recovery capacity before acceptance so an outage cannot evict a failed identity.
export const INTERACTION_ADMISSION_LIMIT = 128;
const retryBatchSize = 8;
const retryIntervalMs = 1000;
type PendingFailure = { home: string; owner: HistoryOwner; interactionId: string };
const pendingFailures = new Set<PendingFailure>();
let activeRecorders = 0;
let retryTimer: NodeJS.Timeout | undefined;

export class RecordingFailure extends Error {
  constructor(readonly interactionId?: string) {
    super(interactionId ? `history_recording_failed:${interactionId}` : "history_recording_failed");
    this.name = "RecordingFailure";
  }
}

function scheduleRetry(): void {
  if (retryTimer || pendingFailures.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    flushPendingInteractionFailures();
  }, retryIntervalMs);
  retryTimer.unref();
}

/** Retry terminal metadata only, in bounded nonblocking batches; never replay agent work. */
export function flushPendingInteractionFailures(): number {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  for (const pending of [...pendingFailures].slice(0, retryBatchSize)) {
    let store: HistoryStore | undefined;
    try {
      store = openHistoryStore({ home: pending.home, owner: pending.owner, busyTimeoutMs: 0 });
      if (!store.abortUnfinished({ interactionId: pending.interactionId })) {
        const row = store.getInteraction(pending.interactionId);
        if (
          !row ||
          row.ownerToken !== pending.owner.token ||
          row.status === "running" ||
          !row.incomplete
        )
          throw new Error("history_terminal_not_owned");
      }
      pendingFailures.delete(pending);
    } catch {
      // Rotate unsuccessful entries so a persistently unwritable home cannot starve others.
      pendingFailures.delete(pending);
      pendingFailures.add(pending);
    } finally {
      try {
        store?.close();
      } catch {
        /* No payloads or database errors in fallback diagnostics. */
      }
    }
  }
  scheduleRetry();
  return pendingFailures.size;
}

interface RunState {
  id: number;
  toolOrdinal: number;
  modelOrdinal: number;
  status?: TerminalStatus;
  parent?: RunState;
  controller: AbortController;
  signal: AbortSignal;
}
interface RecordingState {
  store: HistoryStore;
  accepted: AcceptedInteraction;
  retry: PendingFailure;
  controller: AbortController;
  failure?: RecordingFailure;
  status?: TerminalStatus;
  closed: boolean;
  admitted: boolean;
}

export function beginInteraction(
  input: AcceptInteractionInput,
  options: InteractionOptions = {}
): InteractionRecorder {
  if (activeRecorders + pendingFailures.size >= INTERACTION_ADMISSION_LIMIT)
    throw new Error("history_admission_limit");
  ++activeRecorders;
  let store: HistoryStore | undefined;
  try {
    const home = path.resolve(options.home ?? agentOpsHome());
    store = openHistoryStore({ ...options, home });
    const resolvedHome = fs.realpathSync(home);
    const controller = new AbortController();
    const signal = combineAbortSignals(controller.signal, options.signal)!;
    const accepted = store.acceptInteraction(input);
    const state: RecordingState = {
      store,
      accepted,
      retry: { home: resolvedHome, owner: store.owner, interactionId: accepted.interactionId },
      controller,
      closed: false,
      admitted: accepted.claimed
    };
    if (!accepted.claimed) --activeRecorders;
    const runController = new AbortController();
    return new Recorder(
      state,
      {
        id: accepted.runId,
        toolOrdinal: 0,
        modelOrdinal: 0,
        controller: runController,
        signal: combineAbortSignals(signal, runController.signal)!
      },
      undefined,
      "interaction"
    );
  } catch {
    --activeRecorders;
    try {
      store?.close();
    } catch {
      /* Preserve the acceptance failure. */
    }
    logger.error({}, "interaction.recording_start_failed");
    throw new RecordingFailure();
  }
}

class Recorder {
  constructor(
    private readonly state: RecordingState,
    private readonly run: RunState,
    private readonly call?: { id: number; runId: number },
    private readonly scope: "interaction" | "run" | "call" = "call",
    readonly signal: AbortSignal = run.signal
  ) {}

  get claimed(): boolean {
    return this.state.accepted.claimed;
  }
  get interactionId(): string {
    return this.state.accepted.interactionId;
  }
  get runId(): number {
    return this.run.id;
  }
  get userMessageId(): number {
    return this.state.accepted.messageId;
  }
  get parentCallId(): number | undefined {
    return this.call?.id;
  }
  get artifactsPath(): string {
    return historyArtifactsPath(this.state.retry.home);
  }

  private assertWritable(): void {
    if (this.state.failure) throw this.state.failure;
    if (!this.claimed) throw new Error("interaction_not_claimed");
    if (this.state.closed) throw new Error("interaction_closed");
  }

  private runEnded(): boolean {
    for (let run: RunState | undefined = this.run; run; run = run.parent)
      if (run.status) return true;
    return !!this.state.status;
  }

  /** Check the fatal latch even after normal finalization, before returning success. */
  assertHealthy(): void {
    this.assertWritable();
  }

  private assertActive(): void {
    this.assertHealthy();
    if (this.runEnded()) throw new Error("interaction_execution_finished");
    if (this.signal.aborted) throw new Error("workflow_aborted");
  }

  private persist<T>(write: () => T): T {
    this.assertWritable();
    try {
      return write();
    } catch {
      throw this.failRecording();
    }
  }

  private failRecording(): RecordingFailure {
    if (this.state.failure) return this.state.failure;
    const failure = new RecordingFailure(this.interactionId);
    this.state.failure = failure;
    pendingFailures.add(this.state.retry);
    this.releaseAdmission();
    this.state.controller.abort(failure);
    try {
      if (this.state.store.abortUnfinished({ interactionId: this.interactionId }))
        pendingFailures.delete(this.state.retry);
    } catch {
      /* Keep only the reserved, payload-free retry identity. */
    }
    scheduleRetry();
    logger.error({ interaction_id: this.interactionId }, "interaction.recording_failed");
    return failure;
  }

  childRun(
    input: Omit<CreateRunInput, "interactionId" | "parentRunId" | "triggeringToolCallId">
  ): InteractionRecorder {
    this.assertActive();
    const id = this.persist(() =>
      this.state.store.createRun({
        ...input,
        interactionId: this.interactionId,
        parentRunId: this.runId,
        triggeringToolCallId: this.call?.runId === this.runId ? this.call.id : undefined
      })
    );
    const controller = new AbortController();
    return new Recorder(
      this.state,
      {
        id,
        toolOrdinal: 0,
        modelOrdinal: 0,
        parent: this.run,
        controller,
        signal: combineAbortSignals(this.signal, controller.signal)!
      },
      this.call,
      "run"
    );
  }

  recordTool<T>(
    input: RecordedToolInput,
    execute: (recording: InteractionRecorder, signal: AbortSignal) => T,
    signal?: AbortSignal
  ): T {
    this.assertActive();
    const combined = combineAbortSignals(this.signal, signal)!;
    if (combined.aborted) throw new Error("workflow_aborted");
    const id = this.persist(() =>
      this.state.store.startToolCall({
        ...input,
        runId: this.runId,
        ordinal: ++this.run.toolOrdinal,
        parentCallId: this.parentCallId
      })
    );
    const child = new Recorder(this.state, this.run, { id, runId: this.runId }, "call", combined);
    const finish = (value: unknown, failed: boolean): unknown => {
      this.assertWritable();
      if (this.runEnded()) throw new Error("interaction_execution_finished");
      const cancelled = combined.aborted;
      this.persist(() =>
        this.state.store.finishToolCall({
          id,
          status: cancelled ? "cancelled" : failed ? "failed" : "completed",
          ...(cancelled
            ? { error: "tool_aborted_outcome_unobserved" }
            : failed
              ? { error: value }
              : { result: value })
        })
      );
      if (cancelled) throw new Error("workflow_aborted");
      if (failed) throw value;
      return value;
    };
    let output: T;
    try {
      output = execute(child, combined);
    } catch (error) {
      return finish(error, true) as T;
    }
    if (
      typeof output === "object" &&
      output !== null &&
      "then" in output &&
      typeof output.then === "function"
    )
      return Promise.resolve(output).then(
        (value) => finish(value, false),
        (error: unknown) => finish(error, true)
      ) as T;
    return finish(output, false) as T;
  }

  modelStart(input: Omit<StartModelCallInput, "runId" | "ordinal">): number {
    this.assertActive();
    return this.persist(() =>
      this.state.store.startModelCall({
        ...input,
        runId: this.runId,
        ordinal: ++this.run.modelOrdinal
      })
    );
  }

  modelFinish(input: FinishModelCallInput): boolean {
    this.assertWritable();
    if (this.runEnded()) return false;
    return this.persist(() => this.state.store.finishModelCall(input));
  }

  appendMessage(input: Omit<AppendMessageInput, "interactionId" | "runId">): number {
    return this.persist(() =>
      this.state.store.appendMessage({
        ...input,
        interactionId: this.interactionId,
        runId: this.runId
      })
    );
  }

  updateRun(input: Omit<UpdateRunInput, "id">): boolean {
    this.assertActive();
    return this.persist(() => this.state.store.updateRun({ ...input, id: this.runId }));
  }
  coding<T>(operation: (store: CodingStore) => T): T {
    this.assertActive();
    const store = this.persist(() => this.state.store.coding(this.runId));
    try {
      return operation(store);
    } catch (error) {
      if (error instanceof CodingDecisionError) throw error;
      throw this.failRecording();
    }
  }

  registerArtifact(input: Omit<RegisterArtifactInput, "interactionId" | "runId">): number {
    this.assertActive();
    return this.persist(() =>
      this.state.store.registerArtifact({
        ...input,
        interactionId: this.interactionId,
        runId: this.runId
      })
    );
  }

  finishRun(input: Omit<FinishRunInput, "id">): boolean {
    this.assertWritable();
    if (this.runEnded()) return false;
    const changed = this.persist(() => this.state.store.finishRun({ ...input, id: this.runId }));
    if (changed) {
      this.run.status = input.status;
      this.run.controller.abort(new Error("run_finished"));
    }
    return changed;
  }

  finishInteraction(input: Omit<FinishInteractionInput, "id">): boolean {
    this.assertWritable();
    if (this.state.status) return false;
    const changed = this.persist(() =>
      this.state.store.finishInteraction({ ...input, id: this.interactionId })
    );
    if (changed) {
      this.state.status = input.status;
      this.state.controller.abort(new Error("interaction_execution_finished"));
    }
    return changed;
  }

  deliveryStart(input: StartDeliveryAttemptInput): number {
    return this.persist(() => this.state.store.startDeliveryAttempt(input));
  }

  deliveryFinish(input: FinishDeliveryAttemptInput): boolean {
    return this.persist(() => this.state.store.finishDeliveryAttempt(input));
  }

  private releaseAdmission(): void {
    if (this.state.admitted) {
      this.state.admitted = false;
      --activeRecorders;
    }
  }

  /** Root closes the shared connection; child close only finalizes its own unfinished run. */
  close(): void {
    if (this.state.closed) return;
    if (this.scope === "call") return;
    if (this.scope === "run") {
      if (!this.state.failure && !this.runEnded())
        try {
          this.finishRun({ status: "interrupted", error: "recorder_closed" });
        } catch {
          /* Latched. */
        }
      return;
    }
    if (this.claimed && !this.state.failure && !this.state.status)
      try {
        this.finishInteraction({
          status: "interrupted",
          error: "recorder_closed",
          incomplete: true
        });
      } catch {
        /* Latched. */
      }
    try {
      this.state.store.close();
    } catch {
      if (this.claimed) this.failRecording();
    } finally {
      this.state.closed = true;
      this.releaseAdmission();
    }
  }
}
