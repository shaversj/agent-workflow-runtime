import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import { readDesktop } from "../src/surfaces/desktop/reader.js";
import { historyArtifactsPath, historyDatabasePath } from "../src/workspaces/storage.js";

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-reader-")));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

it("does not create absent history and rejects renderer filesystem authority", () => {
  expect(readDesktop({ method: "list", options: {} }, home)).toMatchObject({
    ok: true,
    data: { store: "absent" }
  });
  for (const request of [
    { method: "list", options: { home: "/tmp" } },
    { method: "list", options: { limit: 101 } },
    { method: "show", id: "not-an-id", options: {} },
    { method: "report", interactionId: crypto.randomUUID(), path: "/etc/passwd" },
    { method: "execute" }
  ])
    expect(readDesktop(request, home)).toMatchObject({ ok: false });
  expect(fs.readdirSync(home)).toEqual([]);
});

it("reads previews, nested activity and reports without changing saved execution", () => {
  const store = openHistoryStore({ home });
  const accepted = store.acceptInteraction({
    source: "discord",
    applicationId: "test-app",
    sourceMessageId: "test-message",
    kind: "chat",
    userMessage: "Inspect this repository"
  });
  const child = store.createRun({
    interactionId: accepted.interactionId,
    parentRunId: accepted.runId,
    kind: "readiness_sweep",
    target: "https://github.com/example/repo",
    ref: "main",
    commitSha: "a".repeat(40)
  });
  const file = path.join(historyArtifactsPath(home), "report.md");
  fs.writeFileSync(file, "# Report\n\nSaved evidence.");
  const artifact = store.registerArtifact({
    interactionId: accepted.interactionId,
    runId: child,
    path: file,
    type: "markdown"
  });
  store.close();
  const before = fs.readFileSync(historyDatabasePath(home));
  expect(readDesktop({ method: "list", options: {} }, home)).toMatchObject({
    ok: true,
    data: { interactions: [{ requestPreview: "Inspect this repository", status: "running" }] }
  });
  expect(
    readDesktop({ method: "show", id: accepted.interactionId, options: {} }, home)
  ).toMatchObject({ ok: true, data: { found: true, interaction: { status: "running" } } });
  expect(
    readDesktop(
      { method: "report", interactionId: accepted.interactionId, artifactId: artifact },
      home
    )
  ).toMatchObject({
    ok: true,
    data: { available: true, content: "# Report\n\nSaved evidence.", truncated: false }
  });
  expect(
    readDesktop(
      { method: "report", interactionId: crypto.randomUUID(), artifactId: artifact },
      home
    )
  ).toMatchObject({ ok: true, data: { available: false } });
  expect(fs.readFileSync(historyDatabasePath(home))).toEqual(before);
  fs.unlinkSync(file);
  expect(
    readDesktop(
      { method: "report", interactionId: accepted.interactionId, artifactId: artifact },
      home
    )
  ).toMatchObject({ ok: true, data: { available: false } });
  fs.symlinkSync(historyDatabasePath(home), file);
  expect(
    readDesktop(
      { method: "report", interactionId: accepted.interactionId, artifactId: artifact },
      home
    )
  ).toMatchObject({ ok: true, data: { available: false } });
});

it("pages previews with filter-bound cursors and retains capture and usage limitations", () => {
  const store = openHistoryStore({ home });
  try {
    const first = store.acceptInteraction({
      source: "cli",
      kind: "chat",
      target: "repo-a",
      userMessage: "x".repeat(300)
    });
    store.acceptInteraction({
      source: "cli",
      kind: "chat",
      target: "repo-a",
      userMessage: "Second request"
    });
    const model = store.startModelCall({
      runId: first.runId,
      ordinal: 1,
      provider: "minimax",
      model: "test-model"
    });
    store.finishModelCall({ id: model, status: "completed" });
    const tool = store.startToolCall({
      runId: first.runId,
      ordinal: 1,
      name: "read_file",
      kind: "capability",
      input: {}
    });
    store.finishToolCall({ id: tool, status: "completed", result: "x".repeat(100000) });
    const listing = readDesktop({ method: "list", options: { target: "repo-a", limit: 1 } }, home);
    expect(listing.ok && listing.method === "list").toBe(true);
    if (!listing.ok || listing.method !== "list") throw new Error("Expected list");
    const next = readDesktop(
      { method: "list", options: { target: "repo-a", limit: 1, cursor: listing.data.nextCursor } },
      home
    );
    expect(next.ok && next.method === "list").toBe(true);
    if (!next.ok || next.method !== "list") throw new Error("Expected next page");
    expect(next.data.interactions[0]?.id).not.toBe(listing.data.interactions[0]?.id);
    expect(next.data.nextCursor).toBeNull();
    expect(
      readDesktop(
        { method: "list", options: { target: "repo-b", cursor: listing.data.nextCursor } },
        home
      ).ok
    ).toBe(false);
    const all = [...listing.data.interactions, ...next.data.interactions];
    expect(all.find((row) => row.id === first.interactionId)).toMatchObject({
      requestPreviewLimited: true,
      requestPreview: "x".repeat(240),
      usage: { knownCalls: 0, unknownCalls: 1 }
    });
    const detail = readDesktop({ method: "show", id: first.interactionId, options: {} }, home);
    if (!detail.ok || detail.method !== "show" || !detail.data.found)
      throw new Error("Expected detail");
    expect(detail.data.activity.items.find((item) => item.kind === "tool")).toMatchObject({
      record: { result: { incomplete: true } }
    });
  } finally {
    store.close();
  }
});

it("bounds report bytes and rejects registered paths that escape the artifact root", () => {
  const store = openHistoryStore({ home });
  const request = store.acceptInteraction({ source: "cli", kind: "chat", userMessage: "Report" });
  const file = path.join(historyArtifactsPath(home), "large.md");
  fs.writeFileSync(file, "a".repeat(300000));
  const id = store.registerArtifact({
    interactionId: request.interactionId,
    runId: request.runId,
    path: file,
    type: "markdown"
  });
  store.close();
  const query = { method: "report", interactionId: request.interactionId, artifactId: id };
  const result = readDesktop(query, home);
  expect(result).toMatchObject({ ok: true, data: { available: true, truncated: true } });
  if (!result.ok || result.method !== "report" || !result.data.available)
    throw new Error("Expected report");
  expect(Buffer.byteLength(result.data.content)).toBe(262144);
  const db = new Database(historyDatabasePath(home));
  try {
    db.prepare("UPDATE artifact SET path=? WHERE id=?").run(historyDatabasePath(home), id);
  } finally {
    db.close();
  }
  expect(readDesktop(query, home)).toMatchObject({ ok: true, data: { available: false } });
});
