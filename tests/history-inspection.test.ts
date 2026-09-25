import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listHistory, showHistory } from "../src/db/history.js";
import { openHistoryReadConnection, openHistoryStore } from "../src/db/index.js";
import { runHistoryCli } from "../src/surfaces/cli/history.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

let home: string;
const handles: { close(): void }[] = [];
const timestamp = "2026-09-09T12:00:00.000Z";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "history-inspection-"));
  vi.stubEnv("AGENT_OPS_HOME", home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0).reverse()) handle.close();
  fs.rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});
function fixture() {
  const store = openHistoryStore({
    owner: { token: "inspection-fixture", pid: process.pid, host: os.hostname() }
  });
  handles.push(store);
  const sqlite = new Database(historyDatabasePath(home));
  handles.push(sqlite);
  const accept = (target?: string) =>
    store.acceptInteraction({
      source: "cli",
      kind: "chat",
      userMessage: "local transcript marker",
      target
    });
  return { store, sqlite, accept };
}

describe("local history inspection", () => {
  it("distinguishes an absent store from corrupt and newer state without creating history", () => {
    expect(listHistory()).toEqual({ store: "absent", interactions: [], nextCursor: null });
    expect(showHistory(crypto.randomUUID())).toMatchObject({ store: "absent", found: false });
    expect(fs.readdirSync(home)).toEqual([]);
    fs.mkdirSync(path.dirname(historyDatabasePath(home)));
    fs.writeFileSync(historyDatabasePath(home), "not sqlite");
    expect(() => listHistory()).toThrow(/history.*read/i);
    fs.unlinkSync(historyDatabasePath(home));
    const sqlite = new Database(historyDatabasePath(home));
    sqlite.pragma("user_version = 999");
    sqlite.close();
    expect(() => showHistory(crypto.randomUUID())).toThrow(/history.*read/i);
  });

  it("validates every query before opening even an absent store", () => {
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { source: "other" },
      { outcome: "done" },
      { since: "yesterday" },
      { since: "2026-02-30T00:00:00Z" },
      { since: "2026-09-10T00:00:00Z", until: "2026-09-09T00:00:00Z" },
      { cursor: "garbage" },
      { target: 12 },
      { extra: true }
    ])
      expect(() => listHistory(options)).toThrow();
    expect(() => showHistory("1")).toThrow(/invalid/i);
    expect(() => showHistory(crypto.randomUUID(), { limit: 101 })).toThrow();
    expect(() => showHistory(crypto.randomUUID(), { cursor: "garbage" })).toThrow();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("reports an unreadable path explicitly and leaves existing database bytes and schema unchanged", () => {
    fs.mkdirSync(historyDatabasePath(home), { recursive: true });
    expect(() => listHistory()).toThrow(/history.*read/i);
    fs.rmdirSync(historyDatabasePath(home));
    const { store, sqlite, accept } = fixture();
    const { interactionId } = accept();
    const schemaVersion = sqlite.pragma("schema_version", { simple: true });
    sqlite.close();
    store.close();
    const before = fs.readFileSync(historyDatabasePath(home));
    const files = fs.readdirSync(path.dirname(historyDatabasePath(home))).sort();
    listHistory();
    showHistory(interactionId);
    expect(fs.readFileSync(historyDatabasePath(home))).toEqual(before);
    // SQLite may create empty WAL/shared-memory sidecars even on a readonly connection.
    expect(
      fs
        .readdirSync(path.dirname(historyDatabasePath(home)))
        .filter((file) => !file.endsWith("-wal") && !file.endsWith("-shm"))
        .sort()
    ).toEqual(files);
    if (fs.existsSync(historyDatabasePath(home) + "-wal"))
      expect(fs.statSync(historyDatabasePath(home) + "-wal").size).toBe(0);
    const reader = openHistoryReadConnection()!;
    try {
      expect(reader.pragma("schema_version", { simple: true })).toBe(schemaVersion);
    } finally {
      reader.close();
    }
  });

  it("rejects invalid stored timestamps instead of returning unusable cursors", () => {
    const { sqlite, accept } = fixture();
    const { interactionId } = accept();
    for (const value of ["2026-02-30T12:00:00.000Z", "2026-09-09T12:00:00Z"]) {
      sqlite.prepare("UPDATE interaction SET started_at=? WHERE id=?").run(value, interactionId);
      expect(() => listHistory()).toThrow(/history.*read/i);
      expect(() => showHistory(interactionId)).toThrow(/history.*read/i);
    }
  });

  it("pages tied times newest first and binds cursors to normalized filters", () => {
    const { sqlite, accept } = fixture();
    const ids = Array.from({ length: 27 }, () => accept("target-a").interactionId)
      .sort()
      .reverse();
    accept("target-b");
    sqlite.prepare("UPDATE interaction SET started_at=?, status='completed'").run(timestamp);
    const options = {
      target: "target-a",
      source: "cli",
      outcome: "completed",
      since: "2026-09-09T07:00:00-05:00",
      until: timestamp
    };
    const first = listHistory(options);
    expect(first.interactions.map((row) => row.id)).toEqual(ids.slice(0, 20));
    expect(first.nextCursor).toBeTypeOf("string");
    const second = listHistory({ ...options, since: timestamp, cursor: first.nextCursor });
    expect(second.interactions.map((row) => row.id)).toEqual(ids.slice(20));
    expect(second.nextCursor).toBeNull();
    expect(() => listHistory({ ...options, target: "target-b", cursor: first.nextCursor })).toThrow(
      /cursor/i
    );
    expect(() => listHistory({ cursor: first.nextCursor })).toThrow(/cursor/i);
    const bad = Buffer.from(
      JSON.stringify({ version: 1, at: timestamp, id: "not-uuid", context: "x" })
    ).toString("base64url");
    expect(() => listHistory({ cursor: bad })).toThrow();
    expect(listHistory({ target: "none" }).interactions).toEqual([]);
  });

  it("keeps stored outcomes and annotates live, absent, foreign and uncertain owners without recovery", () => {
    const { sqlite, accept } = fixture();
    const statuses = ["running", "completed", "failed", "skipped", "cancelled", "interrupted"];
    for (const status of statuses) {
      const { interactionId } = accept();
      sqlite.prepare("UPDATE interaction SET status=? WHERE id=?").run(status, interactionId);
    }
    const { interactionId } = accept();
    const before = sqlite.prepare("SELECT * FROM interaction ORDER BY id").all();
    expect(listHistory().interactions.find((row) => row.id === interactionId)?.ownership).toBe(
      "live"
    );
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    });
    let detail = showHistory(interactionId);
    expect(detail).toMatchObject({
      found: true,
      interaction: { status: "running", ownership: "absent" }
    });
    probe.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    detail = showHistory(interactionId);
    expect(detail).toMatchObject({ interaction: { ownership: "uncertain" } });
    expect(sqlite.prepare("SELECT * FROM interaction ORDER BY id").all()).toEqual(before);
    sqlite
      .prepare("UPDATE interaction SET owner_host='foreign-fixture' WHERE id=?")
      .run(interactionId);
    expect(showHistory(interactionId)).toMatchObject({ interaction: { ownership: "foreign" } });
    expect(new Set(listHistory().interactions.map((row) => row.status))).toEqual(new Set(statuses));
    const connection = openHistoryReadConnection()!;
    try {
      expect(() => connection.prepare("DELETE FROM interaction").run()).toThrow(/readonly/i);
    } finally {
      connection.close();
    }
  });

  it("counts leaf model observations once across root and nested runs, including known zero", () => {
    const { store, accept } = fixture();
    const { interactionId, runId } = accept();
    const child = store.createRun({ interactionId, parentRunId: runId, kind: "sweep" });
    for (const [index, owner] of [runId, child, child].entries()) {
      const id = store.startModelCall({
        runId: owner,
        ordinal: index + 1,
        provider: "fixture",
        model: "test"
      });
      store.finishModelCall({
        id,
        status: "completed",
        ...(index === 2
          ? {}
          : {
              usage: { inputTokens: index * 3, outputTokens: index * 2 }
            })
      });
    }
    expect(showHistory(interactionId)).toMatchObject({
      interaction: {
        usage: {
          knownCalls: 2,
          unknownCalls: 1,
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5
        }
      }
    });
    expect(listHistory().interactions[0]?.usage).toEqual({
      knownCalls: 2,
      unknownCalls: 1,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5
    });
  });

  it("bounds all six activity types together and traverses large tied-time history without duplicates", () => {
    const { store, sqlite, accept } = fixture();
    const { interactionId, runId } = accept();
    for (let i = 1; i <= 125; i++) {
      const child = store.createRun({ interactionId, parentRunId: runId, kind: "sweep" });
      const messageId = store.appendMessage({
        interactionId,
        role: "assistant",
        content: `reply ${i}`
      });
      store.startToolCall({
        runId: child,
        ordinal: 1,
        name: "fixture",
        kind: "capability",
        input: {}
      });
      store.startModelCall({ runId: child, ordinal: 1, provider: "fixture", model: "test" });
      store.startDeliveryAttempt({ messageId, part: 1, attempt: 1 });
      store.registerArtifact({
        interactionId,
        runId: child,
        path: path.join(fs.realpathSync(home), "history/artifacts", `report-${i}.md`),
        type: "report"
      });
    }
    for (const table of ["run", "tool_call", "model_call", "delivery_attempt"])
      sqlite.prepare(`UPDATE ${table} SET started_at=?`).run(timestamp);
    for (const table of ["message", "artifact"])
      sqlite.prepare(`UPDATE ${table} SET created_at=?`).run(timestamp);
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const result = showHistory(interactionId, { cursor });
      expect(result.found).toBe(true);
      if (!result.found) throw new Error("missing fixture");
      expect(result.activity.items.length).toBeLessThanOrEqual(50);
      all.push(...result.activity.items.map((row) => row.key));
      cursor = result.activity.nextCursor ?? undefined;
      if (cursor) expect(() => showHistory(crypto.randomUUID(), { cursor })).toThrow(/cursor/i);
    } while (cursor);
    expect(all).toHaveLength(752);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...all].sort());
  }, 15_000);

  it("keeps captured payloads local, labels capture and delivery failures and rejects malformed rows", () => {
    const { store, sqlite, accept } = fixture();
    const { interactionId, runId } = accept();
    const secret = "synthetic-history-secret";
    vi.stubEnv("GH_TOKEN", secret);
    const messageId = store.appendMessage({
      interactionId,
      role: "assistant",
      content: `${secret} ${"x".repeat(70000)}`
    });
    const tool = store.startToolCall({
      runId,
      ordinal: 1,
      name: "fixture",
      kind: "capability",
      input: "local payload marker"
    });
    store.finishToolCall({ id: tool, status: "completed" });
    const delivery = store.startDeliveryAttempt({ messageId, part: 1, attempt: 1 });
    store.finishDeliveryAttempt({ id: delivery, status: "failed", error: "fixture failure" });
    const listing = JSON.stringify(listHistory());
    expect(listing).not.toContain("local transcript marker");
    expect(listing).not.toContain("local payload marker");
    const detail = showHistory(interactionId);
    expect(detail).toMatchObject({ interaction: { incomplete: true, delivery: { failed: 1 } } });
    expect(JSON.stringify(detail)).toContain("local transcript marker");
    expect(JSON.stringify(detail)).toContain("local payload marker");
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).not.toContain('"text":"undefined"');
    sqlite.prepare("UPDATE message SET content='{}' WHERE id=?").run(messageId);
    expect(() => showHistory(interactionId)).toThrow(/history.*read/i);
    sqlite.prepare("UPDATE interaction SET status='malformed' WHERE id=?").run(interactionId);
    expect(() => listHistory()).toThrow(/history.*read/i);
  });

  it("renders CLI JSON and human completeness, accepts filters, and rejects unknown arguments", () => {
    const { store, accept } = fixture();
    const { interactionId } = accept();
    store.finishInteraction({ id: interactionId, status: "failed", incomplete: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    runHistoryCli(["list", "--json", "--limit", "1", "--source", "cli", "--outcome", "failed"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      interactions: [{ id: interactionId }]
    });
    runHistoryCli(["show", interactionId]);
    const human = String(log.mock.calls.at(-1)?.[0]);
    expect(human).toMatch(/incomplete/i);
    expect(human).toMatch(/unavailable/i);
    expect(human).toContain("local transcript marker");
    for (const args of [
      ["list", "--wat"],
      ["show"],
      ["list", "--limit", "1x"],
      ["show", interactionId, "--source", "cli"],
      ["list", "extra"]
    ])
      expect(() => runHistoryCli(args)).toThrow();
    runHistoryCli(["show", crypto.randomUUID(), "--json"]);
    expect(process.exitCode).toBe(1);
  });
});
