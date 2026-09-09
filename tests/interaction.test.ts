import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openHistoryReader, openHistoryStore } from "../src/db/index.js";
import {
  beginInteraction,
  flushPendingInteractionFailures,
  INTERACTION_ADMISSION_LIMIT,
  RecordingFailure
} from "../src/harness/interaction.js";
import type { InteractionRecorder } from "../src/harness/interaction.js";
import { toPiAgentTools } from "../src/harness/pi-tools.js";
import { withWorkflowTimeout } from "../src/harness/timeout.js";
import { logger } from "../src/logger.js";
import { createCatalogBridgeTools } from "../src/tools/catalog-bridge.js";
import {
  defineRegisteredTool,
  ToolParameterValidationError,
  ToolResultValidationError
} from "../src/tools/registry.js";
import type { RegisteredToolContext, RegisteredToolResult } from "../src/tools/registry.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

const homes: string[] = [];
const handles: { close(): void }[] = [];
const request = { source: "cli" as const, kind: "chat", userMessage: "hello" };
const result = { result: { ok: true }, text: "done" };
function homeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "interaction-"));
  homes.push(home);
  return home;
}
function fixture(options: { signal?: AbortSignal } = {}) {
  const home = homeFixture();
  const recording = beginInteraction(request, { home, busyTimeoutMs: 0, ...options });
  handles.push(recording);
  const db = new Database(historyDatabasePath(home), { timeout: 0 });
  const reader = openHistoryReader({ home })!;
  handles.push(db, reader);
  return { home, recording, db, reader, context: { surface: "cli" as const, recording } };
}
function tool(
  name: string,
  execute: (
    context: RegisteredToolContext,
    signal?: AbortSignal
  ) =>
    RegisteredToolResult<{ ok: boolean }> | Promise<RegisteredToolResult<{ ok: boolean }>> = () =>
    result
) {
  return defineRegisteredTool({
    pluginName: "test",
    name,
    label: name,
    description: name,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    resultSchema: Type.Object({ ok: Type.Boolean() }),
    execute: (_params, context, signal) => execute(context, signal)
  });
}
function blockTerminal(db: Database.Database) {
  db.exec(
    "CREATE TRIGGER block_terminal BEFORE UPDATE ON interaction BEGIN SELECT RAISE(ABORT, 'synthetic-private-db-error'); END"
  );
}
afterEach(() => {
  vi.useRealTimers();
  for (const handle of handles)
    if (handle instanceof Database && handle.open && handle.inTransaction) handle.exec("ROLLBACK");
  for (const home of homes) {
    if (!fs.existsSync(historyDatabasePath(home))) continue;
    const db = new Database(historyDatabasePath(home), { timeout: 0 });
    for (const name of [
      "block_terminal",
      "block_start",
      "block_result",
      "block_delivery",
      "block_accept"
    ])
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.close();
  }
  for (const handle of handles.splice(0).reverse()) handle.close();
  let pending = flushPendingInteractionFailures();
  for (let i = 0; pending > 0 && i < INTERACTION_ADMISSION_LIMIT; i++)
    pending = flushPendingInteractionFailures();
  expect(pending).toBe(0);
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("interaction recorder", () => {
  it("commits acceptance before work and forbids a duplicate from executing or finalizing", () => {
    const home = homeFixture();
    const input = {
      ...request,
      source: "discord" as const,
      applicationId: "app",
      sourceMessageId: "msg"
    };
    const first = beginInteraction(input, { home });
    const duplicate = beginInteraction(input, { home });
    handles.push(first, duplicate);
    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({
      claimed: false,
      interactionId: first.interactionId,
      runId: first.runId,
      userMessageId: first.userMessageId
    });
    expect(() => duplicate.assertHealthy()).toThrow(/not_claimed/);
    expect(() => duplicate.finishInteraction({ status: "completed" })).toThrow(/not_claimed/);
    duplicate.close();
    const reader = openHistoryReader({ home })!;
    handles.push(reader);
    expect(reader.listMessages(first.interactionId)[0]?.id).toBe(first.userMessageId);
    expect(reader.getInteraction(first.interactionId)?.status).toBe("running");
  });

  it("does no work if acceptance cannot commit, and reports only safe diagnostics", () => {
    const { home, db, reader } = fixture();
    const diagnostic = vi.spyOn(logger, "error");
    db.exec(
      "CREATE TRIGGER block_accept BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'synthetic-private-db-error'); END"
    );
    const work = vi.fn();
    expect(() => {
      beginInteraction(request, { home, busyTimeoutMs: 0 });
      work();
    }).toThrow(RecordingFailure);
    expect(work).not.toHaveBeenCalled();
    expect(reader.listInteractions()).toHaveLength(1);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private-db-error");
    db.exec("DROP TRIGGER block_accept");
  });

  it("records direct, nested and catalog calls once with inherited parents and outer provider IDs", async () => {
    const { recording, reader, context } = fixture();
    const leaf = tool("leaf", (ctx) => {
      expect(reader.listToolCalls(recording.runId).at(-1)).toMatchObject({
        name: "test_leaf",
        status: "running"
      });
      expect(ctx.providerCallId).toBeUndefined();
      return result;
    });
    const nested = tool("nested", (ctx, signal) => leaf.execute({}, ctx, signal));
    expect(nested.execute({}, context)).toBe(result);
    const [search, dispatch] = createCatalogBridgeTools([nested], "cli");
    const [piSearch, piDispatch] = toPiAgentTools([search!, dispatch!], context);
    await piSearch!.execute("provider-search", {});
    await piDispatch!.execute("provider-execute", { tool_name: "test_nested" });
    const calls = reader.listToolCalls(recording.runId);
    expect(calls.map(({ kind }) => kind)).toEqual([
      "capability",
      "capability",
      "discovery",
      "dispatch",
      "capability",
      "capability"
    ]);
    expect(calls.map(({ parentCallId }) => parentCallId)).toEqual([
      null,
      calls[0]!.id,
      null,
      null,
      calls[3]!.id,
      calls[4]!.id
    ]);
    expect(calls.map(({ providerCallId }) => providerCallId)).toEqual([
      null,
      null,
      "provider-search",
      "provider-execute",
      null,
      null
    ]);
    expect(calls.every(({ status }) => status === "completed")).toBe(true);
    expect(calls.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("links child runs to their triggering capability and keeps model observations separate", async () => {
    const { recording, reader, context } = fixture();
    const rootModel = recording.modelStart({ provider: "fake", model: "router" });
    recording.modelFinish({ id: rootModel, status: "completed" });
    let child!: InteractionRecorder;
    const workflow = tool("workflow", async (ctx) => {
      child = ctx.recording!.childRun({ kind: "sweep" });
      const model = child.modelStart({ provider: "fake", model: "worker" });
      child.modelFinish({
        id: model,
        status: "completed",
        usage: { inputTokens: 0, outputTokens: 0 }
      });
      await tool("evidence").execute({}, { ...ctx, recording: child });
      child.finishRun({ status: "completed" });
      child.close();
      return result;
    });
    await workflow.execute({}, context);
    expect(reader.getRun(child.runId)).toMatchObject({
      parentRunId: recording.runId,
      triggeringToolCallId: reader.listToolCalls(recording.runId)[0]!.id
    });
    expect(reader.listToolCalls(child.runId)[0]).toMatchObject({
      parentCallId: reader.listToolCalls(recording.runId)[0]!.id,
      ordinal: 1
    });
    expect(reader.listModelCalls(recording.runId)[0]).toMatchObject({
      usageState: "unknown",
      totalTokens: null
    });
    expect(reader.listModelCalls(child.runId)[0]).toMatchObject({
      usageState: "known",
      totalTokens: 0
    });
    const answer = recording.appendMessage({ role: "assistant", content: "answer" });
    recording.finishInteraction({ status: "completed" });
    const send = recording.deliveryStart({ messageId: answer, part: 1, attempt: 1 });
    recording.deliveryFinish({ id: send, status: "acknowledged", surfaceMessageId: "reply" });
    expect(reader.listMessages(recording.interactionId)).toHaveLength(2);
    expect(reader.listDeliveryAttempts(answer)[0]?.status).toBe("acknowledged");
  });

  it("appends the canonical CLI summary after run completion and before interaction completion", () => {
    const { recording, reader } = fixture();
    recording.finishRun({ status: "completed" });
    recording.assertHealthy();
    const summary = recording.appendMessage({ role: "assistant", content: "CLI summary" });
    recording.finishInteraction({ status: "completed" });
    recording.assertHealthy();
    const delivery = recording.deliveryStart({ messageId: summary, part: 1, attempt: 1 });
    recording.deliveryFinish({ id: delivery, status: "failed", error: "stdout_closed" });
    expect(reader.listMessages(recording.interactionId)[1]).toMatchObject({
      runId: recording.runId,
      content: { text: "CLI summary" }
    });
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "completed",
      incomplete: false
    });
    expect(reader.listDeliveryAttempts(summary)[0]?.status).toBe("failed");
  });

  it("records invalid parameters before validation, sync throws, rejections and invalid results", async () => {
    const { recording, reader, context } = fixture();
    const execute = vi.fn(() => result);
    expect(() => tool("params", execute).execute({ value: 42 }, context)).toThrow(
      ToolParameterValidationError
    );
    expect(execute).not.toHaveBeenCalled();
    expect(() =>
      tool("throws", () => {
        throw new Error("sync_failure");
      }).execute({}, context)
    ).toThrow("sync_failure");
    await expect(
      tool("rejects", () => Promise.reject(new Error("async_failure"))).execute({}, context)
    ).rejects.toThrow("async_failure");
    for (const asyncResult of [false, true]) {
      const bad = { result: { ok: true }, text: 42 } as unknown as typeof result;
      const invalid = tool("invalid", () => (asyncResult ? Promise.resolve(bad) : bad));
      if (asyncResult)
        await expect(invalid.execute({}, context)).rejects.toThrow(ToolResultValidationError);
      else expect(() => invalid.execute({}, context)).toThrow(ToolResultValidationError);
    }
    const calls = reader.listToolCalls(recording.runId);
    expect(calls).toHaveLength(5);
    expect(
      calls.every(({ status, error, finishedAt }) => status === "failed" && error && finishedAt)
    ).toBe(true);
    expect(calls[0]?.input.text).toContain("42");
    expect(calls[0]?.error?.text).toContain("Invalid parameters");
    recording.assertHealthy();
  });

  it("prevents dispatch when the committed tool start fails and retries the terminal while owner lives", () => {
    const { home, recording, db, reader, context } = fixture();
    const diagnostic = vi.spyOn(logger, "error");
    blockTerminal(db);
    db.exec(
      "CREATE TRIGGER block_start BEFORE INSERT ON tool_call BEGIN SELECT RAISE(ABORT, 'synthetic-private-db-error'); END"
    );
    const execute = vi.fn(() => result);
    expect(() => tool("first", execute).execute({}, context)).toThrow(RecordingFailure);
    expect(execute).not.toHaveBeenCalled();
    expect(recording.signal.aborted).toBe(true);
    expect(reader.listToolCalls(recording.runId)).toEqual([]);
    expect(reader.getInteraction(recording.interactionId)?.status).toBe("running");
    recording.close();
    expect(flushPendingInteractionFailures()).toBe(1);
    db.exec("DROP TRIGGER block_terminal; DROP TRIGGER block_start");
    expect(flushPendingInteractionFailures()).toBe(0);
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "failed",
      incomplete: true,
      ownerPid: process.pid
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-private-db-error");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(home);
    expect(JSON.stringify(diagnostic.mock.calls)).toContain(recording.interactionId);
  });

  it("latches a post-side-effect storage failure across child and Pi boundaries even when errors are swallowed", async () => {
    const { recording, db, reader, context } = fixture();
    let child!: InteractionRecorder;
    let sideEffects = 0;
    let observedSignal: AbortSignal | undefined;
    const first = tool("first", (ctx, signal) => {
      child = ctx.recording!.childRun({ kind: "nested" });
      observedSignal = signal;
      sideEffects++;
      blockTerminal(db);
      db.exec(
        "CREATE TRIGGER block_result BEFORE UPDATE ON tool_call BEGIN SELECT RAISE(ABORT, 'synthetic-private-db-error'); END"
      );
      return result;
    });
    const second = tool("second", () => {
      sideEffects++;
      return result;
    });
    const [piFirst, piSecond] = toPiAgentTools([first, second], context);
    await expect(piFirst!.execute("first", {})).rejects.toThrow(RecordingFailure);
    await expect(piSecond!.execute("second", {})).rejects.toThrow(RecordingFailure);
    expect(() => second.execute({}, { ...context, recording: child })).toThrow(RecordingFailure);
    expect(() => child.modelStart({ provider: "fake", model: "must-not-start" })).toThrow(
      RecordingFailure
    );
    expect(() => recording.finishInteraction({ status: "completed" })).toThrow(RecordingFailure);
    expect(sideEffects).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(reader.listToolCalls(recording.runId)).toMatchObject([
      { name: "test_first", status: "running", result: null }
    ]);
    db.exec("DROP TRIGGER block_result; DROP TRIGGER block_terminal");
    expect(flushPendingInteractionFailures()).toBe(0);
    expect(reader.listToolCalls(recording.runId)).toMatchObject([
      { name: "test_first", status: "failed", result: null }
    ]);
    expect(sideEffects).toBe(1);
    expect(() => recording.assertHealthy()).toThrow(RecordingFailure);
  });

  it("automatically retries after a SQLite lock clears without keeping the process alive", async () => {
    vi.useFakeTimers();
    const { recording, db, reader, context } = fixture();
    db.exec("BEGIN IMMEDIATE");
    expect(() => tool("locked").execute({}, context)).toThrow(RecordingFailure);
    expect(reader.getInteraction(recording.interactionId)?.status).toBe("running");
    db.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(1500);
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "failed",
      incomplete: true
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds active plus pending admission without evicting failed identities", () => {
    const { home, db, recording, reader, context } = fixture();
    const active = [recording];
    for (let i = 1; i < INTERACTION_ADMISSION_LIMIT; i++) {
      const next = beginInteraction(request, { home, busyTimeoutMs: 0 });
      active.push(next);
      handles.push(next);
    }
    expect(() => beginInteraction(request, { home })).toThrow(/admission/);
    blockTerminal(db);
    db.exec(
      "CREATE TRIGGER block_start BEFORE INSERT ON tool_call BEGIN SELECT RAISE(ABORT, 'fixture'); END"
    );
    expect(() => tool("failure").execute({}, context)).toThrow(RecordingFailure);
    recording.close();
    expect(() => beginInteraction(request, { home })).toThrow(/admission/);
    db.exec("DROP TRIGGER block_terminal; DROP TRIGGER block_start");
    expect(flushPendingInteractionFailures()).toBe(0);
    const admitted = beginInteraction(request, { home });
    handles.push(admitted);
    expect(admitted.claimed).toBe(true);
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "failed",
      incomplete: true
    });
  });

  it("preserves completed execution and its answer when recording delivery fails", () => {
    const { recording, reader, db } = fixture();
    const answer = recording.appendMessage({ role: "assistant", content: "generated answer" });
    recording.finishInteraction({ status: "completed" });
    const send = recording.deliveryStart({ messageId: answer, part: 1, attempt: 1 });
    blockTerminal(db);
    db.exec(
      "CREATE TRIGGER block_delivery BEFORE UPDATE ON delivery_attempt BEGIN SELECT RAISE(ABORT, 'fixture'); END"
    );
    expect(() =>
      recording.deliveryFinish({ id: send, status: "acknowledged", surfaceMessageId: "remote" })
    ).toThrow(RecordingFailure);
    recording.close();
    db.exec("DROP TRIGGER block_terminal; DROP TRIGGER block_delivery");
    expect(flushPendingInteractionFailures()).toBe(0);
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "completed",
      incomplete: true
    });
    expect(reader.getRun(recording.runId)?.status).toBe("completed");
    expect(reader.listMessages(recording.interactionId)[1]?.content.text).toBe("generated answer");
    expect(reader.listDeliveryAttempts(answer)[0]).toMatchObject({
      status: "uncertain",
      surfaceMessageId: null
    });
  });

  it("combines caller and recorder cancellation and ignores late tool and model outcomes", async () => {
    const controller = new AbortController();
    const caller = new AbortController();
    const { recording, reader, context } = fixture({ signal: controller.signal });
    const child = recording.childRun({ kind: "child" });
    const model = child.modelStart({ provider: "fake", model: "late" });
    let complete!: (value: typeof result) => void;
    let signal!: AbortSignal;
    const pending = tool("late", (_ctx, toolSignal) => {
      signal = toolSignal!;
      return new Promise<typeof result>((resolve) => {
        complete = resolve;
      });
    }).execute({}, context, caller.signal);
    caller.abort();
    expect(signal.aborted).toBe(true);
    controller.abort();
    recording.finishInteraction({ status: "cancelled", error: "operator_cancelled" });
    complete(result);
    await expect(pending).rejects.toThrow();
    expect(child.modelFinish({ id: model, status: "completed" })).toBe(false);
    expect(recording.finishInteraction({ status: "completed" })).toBe(false);
    expect(reader.listToolCalls(recording.runId)[0]).toMatchObject({
      status: "cancelled",
      result: null
    });
    expect(reader.listModelCalls(child.runId)[0]?.status).toBe("cancelled");
    expect(reader.getInteraction(recording.interactionId)?.error?.text).toBe("operator_cancelled");
  });

  it("passes per-call cancellation through the child recording context", async () => {
    const { recording, context } = fixture();
    const caller = new AbortController();
    let child!: InteractionRecorder;
    let complete!: (value: typeof result) => void;
    const pending = tool("child-signal", (ctx) => {
      child = ctx.recording!.childRun({ kind: "workflow" });
      return new Promise<typeof result>((resolve) => {
        complete = resolve;
      });
    }).execute({}, context, caller.signal);
    caller.abort();
    expect(child.signal.aborted).toBe(true);
    expect(() => child.modelStart({ provider: "fake", model: "cancelled" })).toThrow(/aborted/);
    complete(result);
    await expect(pending).rejects.toThrow(/aborted/);
    recording.assertHealthy();
  });

  it("allows a workflow to create another child without inventing a triggering call in that run", async () => {
    const { recording, context, reader } = fixture();
    let child!: InteractionRecorder;
    let grandchild!: InteractionRecorder;
    await tool("nested-workflow", (ctx) => {
      child = ctx.recording!.childRun({ kind: "child" });
      grandchild = child.childRun({ kind: "grandchild" });
      return result;
    }).execute({}, context);
    expect(reader.getRun(grandchild.runId)).toMatchObject({
      parentRunId: child.runId,
      triggeringToolCallId: null
    });
    recording.assertHealthy();
  });

  it("finalizes unfinished child activity on run cancellation, retaining completed records and the root", async () => {
    const { recording, reader } = fixture();
    const child = recording.childRun({ kind: "child" });
    child.recordTool({ name: "observed", kind: "workflow", input: {} }, () => result);
    const grandchild = child.childRun({ kind: "grandchild" });
    const model = grandchild.modelStart({ provider: "fake", model: "inflight" });
    let complete!: (value: typeof result) => void;
    const pending = child.recordTool(
      { name: "pending", kind: "workflow", input: {} },
      () =>
        new Promise<typeof result>((resolve) => {
          complete = resolve;
        })
    );
    child.finishRun({ status: "cancelled", error: "child_cancelled" });
    expect(child.signal.aborted).toBe(true);
    expect(grandchild.signal.aborted).toBe(true);
    expect(reader.listToolCalls(child.runId).map(({ status }) => status)).toEqual([
      "completed",
      "cancelled"
    ]);
    expect(reader.getRun(grandchild.runId)?.status).toBe("cancelled");
    expect(reader.listModelCalls(grandchild.runId)[0]?.status).toBe("cancelled");
    expect(reader.getInteraction(recording.interactionId)).toMatchObject({
      status: "running",
      incomplete: true
    });
    complete(result);
    await expect(pending).rejects.toThrow();
    expect(grandchild.modelFinish({ id: model, status: "completed" })).toBe(false);
    recording.assertHealthy();
  });

  it("keeps timeout primary when cancellation cleanup throws", async () => {
    const { recording, reader, context } = fixture();
    let complete!: (value: typeof result) => void;
    const pending = tool(
      "timeout",
      () =>
        new Promise<typeof result>((resolve) => {
          complete = resolve;
        })
    ).execute({}, context);
    await expect(
      withWorkflowTimeout(Promise.resolve(pending), 1, () => {
        recording.finishInteraction({ status: "failed", error: "workflow_timeout:1" });
        throw new Error("cleanup_failure");
      })
    ).rejects.toThrow("workflow_timeout:1");
    complete(result);
    await expect(pending).rejects.toThrow();
    expect(reader.getInteraction(recording.interactionId)?.error?.text).toBe("workflow_timeout:1");
    expect(reader.listToolCalls(recording.runId)[0]).toMatchObject({
      status: "failed",
      result: null
    });
  });

  it("recovers a process killed after committed tool start, preserving completed calls and live/foreign/EPERM owners", async () => {
    const { home, recording, reader } = fixture();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { beginInteraction } from './src/harness/interaction.ts';
      const r = beginInteraction({source:'cli',kind:'crash',userMessage:'request'}, {home:process.argv[1]});
      r.recordTool({name:'finished',kind:'capability',input:{}}, () => 'done');
      r.recordTool({name:'pending',kind:'capability',input:{}}, () => {
        process.send({interactionId:r.interactionId,runId:r.runId});
        return new Promise(() => {});
      });
      setInterval(() => {}, 1000);
    `,
        home
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    try {
      const [dead] = (await once(child, "message")) as [{ interactionId: string; runId: number }];
      expect(reader.listToolCalls(dead.runId).map(({ status }) => status)).toEqual([
        "completed",
        "running"
      ]);
      const liveWriter = openHistoryStore({ home });
      handles.push(liveWriter);
      expect(reader.getInteraction(dead.interactionId)?.status).toBe("running");
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      const foreign = openHistoryStore({
        home,
        owner: { token: "foreign", pid: process.pid, host: "foreign-host" }
      });
      handles.push(foreign);
      const foreignRequest = foreign.acceptInteraction(request);
      const uncertain = openHistoryStore({
        home,
        owner: { token: "uncertain", pid: 2147483000, host: os.hostname() }
      });
      handles.push(uncertain);
      const uncertainRequest = uncertain.acceptInteraction(request);
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === 2147483000) throw Object.assign(new Error("permission"), { code: "EPERM" });
        return kill(pid, signal);
      });
      const recovered = openHistoryStore({ home });
      handles.push(recovered);
      expect(reader.listToolCalls(dead.runId).map(({ status }) => status)).toEqual([
        "completed",
        "interrupted"
      ]);
      expect(reader.getInteraction(dead.interactionId)).toMatchObject({
        status: "interrupted",
        incomplete: true
      });
      for (const id of [
        recording.interactionId,
        foreignRequest.interactionId,
        uncertainRequest.interactionId
      ])
        expect(reader.getInteraction(id)?.status).toBe("running");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 10000);
});
