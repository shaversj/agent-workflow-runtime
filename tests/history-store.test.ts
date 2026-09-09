import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openHistoryStore, openHistoryReader } from "../src/db/index.js";
import type { AcceptedInteraction } from "../src/db/index.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

const homes: string[] = [];
const handles: { close(): void }[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "history-store-"));
  homes.push(home);
  const store = openHistoryStore({ home });
  handles.push(store);
  return { home, store };
}
const request = { source: "cli" as const, kind: "chat", userMessage: "Hello" };
afterEach(() => {
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("shared history store", () => {
  it("sanitizes every durable content, metadata and error projection before SQLite binding", () => {
    const { store, home } = fixture();
    const secret = "synthetic-all-writes-credential";
    vi.stubEnv("GH_TOKEN", secret);
    const sensitive = {
      text: `Observed ${secret}`,
      nested: { authorization: "synthetic-nested-auth" },
      url: "https://synthetic-url-token@host.test/?key=synthetic-url-query",
      system: "synthetic-hidden-system"
    };
    const original = structuredClone(sensitive);
    const accepted = store.acceptInteraction({
      ...request,
      kind: secret,
      target: secret,
      conversationKey: secret,
      userMessage: sensitive,
      metadata: sensitive
    });
    const child = store.createRun({
      interactionId: accepted.interactionId,
      parentRunId: accepted.runId,
      kind: secret,
      target: secret,
      ref: secret,
      commitSha: secret,
      metadata: sensitive
    });
    store.updateRun({
      id: child,
      target: secret,
      ref: secret,
      commitSha: secret,
      metadata: sensitive
    });
    const call = store.startToolCall({
      runId: child,
      ordinal: 1,
      name: secret,
      kind: "capability",
      source: secret,
      providerCallId: secret,
      input: sensitive
    });
    store.finishToolCall({ id: call, status: "failed", result: sensitive, error: sensitive });
    const model = store.startModelCall({
      runId: child,
      ordinal: 1,
      provider: secret,
      model: secret
    });
    store.finishModelCall({ id: model, status: "failed", error: sensitive });
    const messageId = store.appendMessage({
      interactionId: accepted.interactionId,
      runId: child,
      role: "assistant",
      content: sensitive
    });
    const artifact = path.join(fs.realpathSync(home), "history", "artifacts", "missing.md");
    store.registerArtifact({
      interactionId: accepted.interactionId,
      runId: child,
      path: artifact,
      type: secret,
      title: secret
    });
    const delivery = store.startDeliveryAttempt({ messageId, part: 1, attempt: 1 });
    store.finishDeliveryAttempt({
      id: delivery,
      status: "failed",
      surfaceMessageId: secret,
      error: sensitive
    });
    store.finishRun({ id: child, status: "failed", error: sensitive });
    store.finishInteraction({ id: accepted.interactionId, status: "failed", error: sensitive });
    const aborted = store.acceptInteraction(request);
    store.abortUnfinished({ interactionId: aborted.interactionId, error: sensitive });
    expect(sensitive).toEqual(original);

    const rows = [
      store.getInteraction(accepted.interactionId),
      store.listRuns(accepted.interactionId),
      store.listMessages(accepted.interactionId),
      store.listToolCalls(child),
      store.listModelCalls(child),
      store.listArtifacts(accepted.interactionId),
      store.listDeliveryAttempts(messageId),
      store.getInteraction(aborted.interactionId)
    ];
    const markers = [
      secret,
      "synthetic-nested-auth",
      "synthetic-url-token",
      "synthetic-url-query",
      "synthetic-hidden-system"
    ];
    for (const marker of markers) expect(JSON.stringify(rows)).not.toContain(marker);
    expect(store.listToolCalls(child)[0]?.result).toMatchObject({
      redacted: true,
      omitted: true,
      incomplete: true
    });
    expect(fs.statSync(historyDatabasePath(home) + "-wal").size).toBeGreaterThan(0);
    const inspect = () => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const file = historyDatabasePath(home) + suffix;
        if (!fs.existsSync(file)) continue;
        for (const marker of markers)
          expect(fs.readFileSync(file).includes(Buffer.from(marker))).toBe(false);
      }
    };
    inspect();
    store.close();
    inspect();
  });

  it("bounds structured metadata and rejects unsafe scalar metadata and identities", () => {
    const { store } = fixture();
    const accepted = store.acceptInteraction({ ...request, metadata: { text: "é".repeat(1025) } });
    expect(store.getInteraction(accepted.interactionId)?.metadata).toMatchObject({
      omitted: true,
      incomplete: true
    });
    expect(store.getInteraction(accepted.interactionId)?.metadata.text).not.toContain("é");
    expect(store.updateRun({ id: accepted.runId, ref: "é".repeat(1024) })).toBe(true);
    expect(() => store.updateRun({ id: accepted.runId, ref: "é".repeat(1025) })).toThrow();
    const secret = "synthetic-identity-secret";
    vi.stubEnv("DISCORD_BOT_TOKEN", secret);
    expect(() =>
      store.acceptInteraction({
        ...request,
        source: "discord",
        applicationId: secret,
        sourceMessageId: "source"
      })
    ).toThrow(/Unsafe/);
    expect(store.listInteractions()).toHaveLength(1);
  });

  it("atomically accepts an untargeted request with a root run and user message", () => {
    const { store, home } = fixture();
    const accepted = store.acceptInteraction(request);
    expect(accepted.claimed).toBe(true);
    expect(store.getInteraction(accepted.interactionId)).toMatchObject({
      source: "cli",
      target: null,
      status: "running",
      ownerPid: process.pid
    });
    expect(store.listRuns(accepted.interactionId)).toHaveLength(1);
    expect(store.listMessages(accepted.interactionId)[0]).toMatchObject({
      role: "user",
      sequence: 1
    });
    expect(store.listArtifacts(accepted.interactionId)).toEqual([]);
    expect(fs.existsSync(path.join(home, "targets"))).toBe(false);
    expect(fs.statSync(historyDatabasePath(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "history")).mode & 0o777).toBe(0o700);
  });

  it("rolls back acceptance on an actual SQLite failure before work can execute", () => {
    const { store, home } = fixture();
    const db = new Database(historyDatabasePath(home));
    handles.push(db);
    db.exec(
      "CREATE TRIGGER fail_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
    );
    let executed = false;
    expect(() => {
      store.acceptInteraction(request);
      executed = true;
    }).toThrow();
    expect(executed).toBe(false);
    for (const table of ["interaction", "run", "message"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("grants only one connection ownership of a Discord source key", () => {
    const { store, home } = fixture();
    const other = openHistoryStore({ home });
    handles.push(other);
    const input = {
      ...request,
      source: "discord" as const,
      applicationId: "bot",
      sourceMessageId: "msg"
    };
    const first = store.acceptInteraction(input);
    const duplicate = other.acceptInteraction(input);
    expect(duplicate).toEqual({ ...first, claimed: false });
    expect(store.listInteractions()).toHaveLength(1);
    expect(store.acceptInteraction(request).interactionId).not.toBe(
      store.acceptInteraction(request).interactionId
    );
  });

  it("links children and calls, separates delivery, and applies terminal observations once", () => {
    const { store } = fixture();
    const accepted = store.acceptInteraction(request);
    const dispatch = store.startToolCall({
      runId: accepted.runId,
      ordinal: 1,
      name: "executeTool",
      kind: "dispatch",
      input: {}
    });
    const child = store.createRun({
      interactionId: accepted.interactionId,
      parentRunId: accepted.runId,
      triggeringToolCallId: dispatch,
      kind: "sweep"
    });
    const call = store.startToolCall({
      runId: child,
      parentCallId: dispatch,
      ordinal: 1,
      name: "sweep",
      kind: "capability",
      input: {}
    });
    expect(store.finishToolCall({ id: call, status: "completed", result: "ok" })).toBe(true);
    expect(store.finishToolCall({ id: call, status: "failed", error: "late" })).toBe(false);
    const model = store.startModelCall({
      runId: child,
      ordinal: 1,
      provider: "fake",
      model: "fake"
    });
    expect(
      store.startModelCall({ runId: child, ordinal: 1, provider: "fake", model: "fake" })
    ).toBe(model);
    expect(
      store.finishModelCall({
        id: model,
        status: "completed",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 20 }
      })
    ).toBe(true);
    expect(
      store.finishModelCall({
        id: model,
        status: "completed",
        usage: { inputTokens: 10, outputTokens: 10 }
      })
    ).toBe(false);
    expect(store.listModelCalls(child)[0]).toMatchObject({
      usageState: "known",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 20
    });
    const message = store.appendMessage({
      interactionId: accepted.interactionId,
      runId: accepted.runId,
      role: "assistant",
      content: "answer"
    });
    expect(store.finishRun({ id: child, status: "completed" })).toBe(true);
    expect(store.finishInteraction({ id: accepted.interactionId, status: "completed" })).toBe(true);
    expect(store.finishInteraction({ id: accepted.interactionId, status: "failed" })).toBe(false);
    const delivery = store.startDeliveryAttempt({ messageId: message, part: 1, attempt: 1 });
    expect(store.finishDeliveryAttempt({ id: delivery, status: "failed", error: "offline" })).toBe(
      true
    );
    expect(store.getInteraction(accepted.interactionId)?.status).toBe("completed");
    expect(store.listMessages(accepted.interactionId)).toHaveLength(2);
  });

  it("keeps unknown usage distinct from zero and rejects foreign owners and relationships", () => {
    const { store, home } = fixture();
    const a = store.acceptInteraction(request);
    const b = store.acceptInteraction(request);
    expect(() =>
      store.createRun({ interactionId: b.interactionId, parentRunId: a.runId, kind: "sweep" })
    ).toThrow();
    const other = openHistoryStore({
      home,
      owner: { token: "other-process", pid: process.pid, host: os.hostname() }
    });
    handles.push(other);
    expect(other.finishInteraction({ id: a.interactionId, status: "failed" })).toBe(false);
    expect(() =>
      other.startToolCall({
        runId: a.runId,
        ordinal: 1,
        name: "test",
        kind: "capability",
        input: {}
      })
    ).toThrow();
    const model = store.startModelCall({
      runId: a.runId,
      ordinal: 1,
      provider: "fake",
      model: "fake"
    });
    store.finishModelCall({ id: model, status: "completed" });
    expect(store.listModelCalls(a.runId)[0]).toMatchObject({
      usageState: "unknown",
      inputTokens: null,
      outputTokens: null
    });
  });

  it("opens absent state read-only without creating it and rejects unknown schemas", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "history-empty-"));
    homes.push(home);
    expect(openHistoryReader({ home })).toBeUndefined();
    expect(fs.readdirSync(home)).toEqual([]);
    const { store, home: existing } = fixture();
    store.close();
    const db = new Database(historyDatabasePath(existing));
    db.pragma("user_version = 99");
    db.close();
    expect(() => openHistoryStore({ home: existing })).toThrow(/version/i);
    expect(() => openHistoryReader({ home: existing })).toThrow(/version/i);
  });

  it("lets a separate process read committed activity while the writer is open", () => {
    const { store, home } = fixture();
    const accepted = store.acceptInteraction(request);
    store.startToolCall({
      runId: accepted.runId,
      ordinal: 1,
      name: "pending",
      kind: "capability",
      input: {}
    });
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { openHistoryReader } from './src/db/index.ts';
      const reader = openHistoryReader({home: process.argv[1]});
      console.log(JSON.stringify(reader.listToolCalls(Number(process.argv[2]))));
      reader.close();
    `,
        home,
        String(accepted.runId)
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    expect(JSON.parse(output)).toMatchObject([
      { name: "pending", status: "running", finishedAt: null }
    ]);
  });

  it("recovers pending delivery for a dead owner without changing completed execution", () => {
    const { store, home } = fixture();
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { openHistoryStore } from './src/db/index.ts';
      const store = openHistoryStore({home: process.argv[1]});
      const a = store.acceptInteraction({source:'cli',kind:'chat',userMessage:'hello'});
      const m = store.appendMessage({interactionId:a.interactionId,role:'assistant',content:'done'});
      store.finishInteraction({id:a.interactionId,status:'completed'});
      store.startDeliveryAttempt({messageId:m,part:1,attempt:1});
      console.log(JSON.stringify({...a,messageId:m}));
      process.exit(0);
    `,
        home
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const dead = JSON.parse(output) as AcceptedInteraction;
    const reader = openHistoryReader({ home })!;
    handles.push(reader);
    expect(reader.listDeliveryAttempts(dead.messageId)[0]?.status).toBe("pending");
    expect(store.reconcileAbsentOwners()).toBe(1);
    expect(store.getInteraction(dead.interactionId)?.status).toBe("completed");
    expect(store.getRun(dead.runId)?.status).toBe("completed");
    expect(store.listDeliveryAttempts(dead.messageId)[0]?.status).toBe("uncertain");
    expect(store.reconcileAbsentOwners()).toBe(0);
  });

  it("can mark failed and incomplete after a temporary write failure, without replacing completed calls", () => {
    const { store, home } = fixture();
    const a = store.acceptInteraction(request);
    const call = store.startToolCall({
      runId: a.runId,
      ordinal: 1,
      name: "done",
      kind: "capability",
      input: {}
    });
    store.finishToolCall({ id: call, status: "completed", result: "ok" });
    const pending = store.startModelCall({
      runId: a.runId,
      ordinal: 1,
      provider: "fake",
      model: "fake"
    });
    const db = new Database(historyDatabasePath(home));
    handles.push(db);
    db.exec(
      "CREATE TRIGGER fail_message BEFORE INSERT ON message BEGIN SELECT RAISE(ABORT, 'temporary failure'); END"
    );
    expect(() =>
      store.appendMessage({ interactionId: a.interactionId, role: "assistant", content: "answer" })
    ).toThrow();
    db.exec("DROP TRIGGER fail_message");
    expect(
      store.abortUnfinished({ interactionId: a.interactionId, error: "recording_failure" })
    ).toBe(true);
    expect(store.getInteraction(a.interactionId)).toMatchObject({
      status: "failed",
      incomplete: true
    });
    expect(store.listToolCalls(a.runId)[0]?.status).toBe("completed");
    expect(store.listModelCalls(a.runId)[0]).toMatchObject({
      id: pending,
      status: "failed",
      usageState: "unknown"
    });
    expect(store.abortUnfinished({ interactionId: a.interactionId })).toBe(false);
  });

  it("updates prepared run metadata only for an active owned run and rejects late call completions", () => {
    const { store, home } = fixture();
    const a = store.acceptInteraction(request);
    expect(
      store.updateRun({
        id: a.runId,
        target: "https://example.com/repo",
        ref: "main",
        commitSha: "abc",
        metadata: { prepared: true }
      })
    ).toBe(true);
    expect(store.getRun(a.runId)).toMatchObject({
      target: "https://example.com/repo",
      ref: "main",
      commitSha: "abc"
    });
    const other = openHistoryStore({
      home,
      owner: { token: "foreign", pid: process.pid, host: os.hostname() }
    });
    handles.push(other);
    expect(other.updateRun({ id: a.runId, ref: "wrong" })).toBe(false);
    const child = store.createRun({
      interactionId: a.interactionId,
      parentRunId: a.runId,
      kind: "sweep"
    });
    const tool = store.startToolCall({
      runId: child,
      ordinal: 1,
      name: "tool",
      kind: "capability",
      input: {}
    });
    const model = store.startModelCall({
      runId: child,
      ordinal: 1,
      provider: "fake",
      model: "fake"
    });
    store.finishRun({ id: child, status: "failed" });
    expect(store.finishToolCall({ id: tool, status: "completed", result: "late" })).toBe(false);
    expect(store.finishModelCall({ id: model, status: "completed" })).toBe(false);
    expect(store.updateRun({ id: child, ref: "late" })).toBe(false);
    store.finishInteraction({ id: a.interactionId, status: "failed" });
    expect(store.updateRun({ id: a.runId, ref: "late" })).toBe(false);
  });

  it("bounds serialized captures, redacts durable bytes, and contains registered artifacts", () => {
    const { store, home } = fixture();
    const marker = "synthetic-private-value";
    const a = store.acceptInteraction({
      ...request,
      userMessage: { password: marker, text: "ok" }
    });
    const m = store.appendMessage({
      interactionId: a.interactionId,
      role: "assistant",
      content: '"'.repeat(63000)
    });
    const content = store.listMessages(a.interactionId).find((row) => row.id === m)!.content;
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(65536);
    expect(() => store.updateRun({ id: a.runId, ref: "é".repeat(1500) })).toThrow();
    expect(() =>
      store.registerArtifact({
        interactionId: a.interactionId,
        path: path.join(home, "outside.md"),
        type: "report"
      })
    ).toThrow();
    const artifact = path.join(fs.realpathSync(home), "history", "artifacts", "report.md");
    fs.writeFileSync(artifact, "report", { mode: 0o600 });
    expect(
      store.registerArtifact({ interactionId: a.interactionId, path: artifact, type: "report" })
    ).toBeGreaterThan(0);
    expect(store.listArtifacts(a.interactionId)[0]?.availability).toBe("available");
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = historyDatabasePath(home) + suffix;
      if (fs.existsSync(file))
        expect(fs.readFileSync(file).includes(Buffer.from(marker))).toBe(false);
    }
  });
});
