import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openHistoryStore } from "../src/db/index.js";
import {
  getLatestInspectionReport,
  listInspectionRuns,
  readInspectionReport,
  showInspectionRun
} from "../src/db/inspection.js";
import { writeSweepReport } from "../src/tools/report.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-history-"));
  vi.stubEnv("AGENT_OPS_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function fixture(target = "/repo/a", kind = "readiness_sweep") {
  const store = openHistoryStore();
  const accepted = store.acceptInteraction({
    source: "cli",
    kind,
    target,
    userMessage: "private user message"
  });
  store.updateRun({
    id: accepted.runId,
    ref: "main",
    commitSha: "abc123",
    metadata: {
      model: "test",
      harnessProvider: "agent-ops-kit",
      benchmark: { status: "revalidated" }
    }
  });
  return { store, ...accepted };
}
it("does not initialize missing history or scan legacy files", () => {
  fs.mkdirSync(path.join(home, "targets", "old", "reports"), { recursive: true });
  fs.writeFileSync(path.join(home, "targets", "old", "agent-ops.db"), "not a database");
  fs.writeFileSync(
    path.join(home, "targets", "old", "reports", "old.md"),
    "# Agent Readiness Sweep"
  );
  expect(listInspectionRuns()).toEqual({ runs: [], count: 0 });
  expect(getLatestInspectionReport()).toBeUndefined();
  expect(fs.existsSync(path.join(home, "history"))).toBe(false);
});
it("uses global run IDs and exposes metadata, not transcript payloads", () => {
  const a = fixture();
  const call = a.store.startToolCall({
    runId: a.runId,
    ordinal: 1,
    name: "evidence",
    kind: "workflow",
    input: "private tool input"
  });
  a.store.finishToolCall({ id: call, status: "completed", result: "private tool output" });
  a.store.finishRun({ id: a.runId, status: "completed" });
  a.store.finishInteraction({ id: a.interactionId, status: "completed" });
  a.store.close();
  const b = fixture("/repo/b");
  b.store.close();
  const chat = fixture("/repo/a", "chat");
  chat.store.close();
  expect(b.runId).not.toBe(a.runId);
  expect(listInspectionRuns().count).toBe(2);
  const found = showInspectionRun(String(a.runId));
  expect(found).toMatchObject({
    found: true,
    run: {
      interaction_id: a.interactionId,
      run_ref: String(a.runId),
      benchmark_status: "revalidated",
      workflow_activity_count: 1,
      tool_call_count: 0
    }
  });
  expect(JSON.stringify(found)).not.toContain("private");
  expect(showInspectionRun(`old:${a.runId}`)).toMatchObject({ found: false });
  expect(showInspectionRun(String(a.runId), { repoTarget: "/repo/b" })).toMatchObject({
    found: false
  });
  expect(showInspectionRun(String(chat.runId))).toMatchObject({ found: false });
});
it("distinguishes unknown usage from measured zero", () => {
  const a = fixture();
  const known = a.store.startModelCall({
    runId: a.runId,
    ordinal: 1,
    provider: "test",
    model: "test"
  });
  a.store.finishModelCall({
    id: known,
    status: "completed",
    usage: { inputTokens: 0, outputTokens: 0 }
  });
  const unknown = a.store.startModelCall({
    runId: a.runId,
    ordinal: 2,
    provider: "test",
    model: "test"
  });
  a.store.finishModelCall({ id: unknown, status: "failed" });
  a.store.close();
  expect(listInspectionRuns().runs[0]).toMatchObject({
    token_count: 0,
    usage_completeness: "unknown"
  });
});
it("reads only registered reports and never substitutes an older file", () => {
  const a = fixture();
  const first = writeSweepReport(a.runId, "first");
  a.store.registerArtifact({
    interactionId: a.interactionId,
    runId: a.runId,
    path: first,
    type: "markdown"
  });
  a.store.close();
  const b = fixture();
  const second = writeSweepReport(b.runId, "second");
  b.store.registerArtifact({
    interactionId: b.interactionId,
    runId: b.runId,
    path: second,
    type: "markdown"
  });
  b.store.close();
  expect(readInspectionReport({ repoTarget: "/repo/a" }).content).toBe("second");
  fs.unlinkSync(second);
  expect(() => getLatestInspectionReport()).toThrow(/missing/i);
  expect(readInspectionReport({ reportPath: first }).content).toBe("first");
});
it("rejects unregistered, traversal, symlink and foreign-target reports", () => {
  const a = fixture();
  const file = writeSweepReport(a.runId, "safe");
  a.store.registerArtifact({
    interactionId: a.interactionId,
    runId: a.runId,
    path: file,
    type: "markdown"
  });
  a.store.close();
  const other = path.join(path.dirname(file), "unregistered.md");
  fs.writeFileSync(other, "unregistered");
  expect(() => readInspectionReport({ reportPath: other })).toThrow();
  expect(() => readInspectionReport({ reportPath: "../secret.md" })).toThrow();
  expect(() => readInspectionReport({ reportPath: file, repoTarget: "/repo/b" })).toThrow();
  fs.unlinkSync(file);
  fs.symlinkSync(other, file);
  expect(() => readInspectionReport({ reportPath: file })).toThrow(/symlink/i);
});
it("bounds report reads and rejects invalid limits", () => {
  const a = fixture();
  const file = writeSweepReport(a.runId, "abc".repeat(100000));
  a.store.registerArtifact({
    interactionId: a.interactionId,
    runId: a.runId,
    path: file,
    type: "markdown"
  });
  a.store.close();
  expect(readInspectionReport({ maxBytes: 4 })).toMatchObject({ content: "abca", truncated: true });
  expect(() => readInspectionReport({ maxBytes: 0 })).toThrow();
  expect(() => listInspectionRuns({ limit: 101 })).toThrow();
});
it("reports corrupt shared history as an error instead of empty", () => {
  fs.mkdirSync(path.join(home, "history"));
  fs.writeFileSync(path.join(home, "history", "agent-ops.db"), "broken");
  expect(() => listInspectionRuns()).toThrow();
});
