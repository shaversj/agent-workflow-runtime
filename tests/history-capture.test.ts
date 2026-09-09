import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import { captureHistory, captureHistoryMetadata } from "../src/harness/history-capture.js";
import { CaptureEnvelopeSchema, parseHistory } from "../src/harness/history-schemas.js";
import { redactEvidenceText } from "../src/harness/redaction.js";
import { historyDatabasePath } from "../src/workspaces/storage.js";

afterEach(() => vi.unstubAllEnvs());

describe("durable history capture", () => {
  it("removes configured credentials from content before SQLite and WAL writes", () => {
    const secret = "synthetic-minimax-private-value";
    vi.stubEnv("MINIMAX_API_KEY", secret);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "history-capture-"));
    const store = openHistoryStore({ home });
    try {
      const accepted = store.acceptInteraction({
        source: "cli",
        kind: "chat",
        userMessage: `Please inspect ${secret}`
      });
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const file = historyDatabasePath(home) + suffix;
        if (fs.existsSync(file))
          expect(fs.readFileSync(file).includes(Buffer.from(secret))).toBe(false);
      }
      expect(store.listMessages(accepted.interactionId)[0]?.content.redacted).toBe(true);
    } finally {
      store.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("redacts token-only URL userinfo, query credentials, bearer values and inline keys", () => {
    const raw = [
      "https://synthetic-userinfo@host.test/repo",
      "https://host.test/?access_token=synthetic-query",
      "Authorization: Bearer synthetic-bearer",
      "api_key=synthetic-inline"
    ].join(" ");
    expect(redactEvidenceText(raw)).not.toMatch(/synthetic-/);
  });

  it("preserves safe content and original operational results without invoking accessors", () => {
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    const result = { text: "answer", nested: { authorization: "synthetic-nested" } };
    const snapshot = structuredClone(result);
    const safe = captureHistory(result);
    expect(result).toEqual(snapshot);
    expect(safe).toMatchObject({ redacted: true, omitted: false, incomplete: false });
    expect(safe.text).not.toContain("synthetic-nested");
    expect(captureHistory("hello")).toEqual({
      text: "hello",
      redacted: false,
      truncated: false,
      omitted: false,
      incomplete: false,
      reasons: [],
      capturedBytes: 5
    });
    const accessor = Object.defineProperty({}, "text", { enumerable: true, get: getter });
    expect(captureHistory(accessor).reasons).toContain("accessor");
    expect(getter).not.toHaveBeenCalled();
  });

  it("reads only the four app credentials, including values configured after import", () => {
    for (const name of ["MINIMAX_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "DISCORD_BOT_TOKEN"]) {
      vi.stubEnv(name, `synthetic-${name}-value`);
      expect(captureHistory(`synthetic-${name}-value`).text).toBe("[REDACTED]");
    }
    vi.stubEnv("UNRELATED_CAPTURE_FIXTURE", "synthetic-unrelated-value");
    expect(captureHistory("synthetic-unrelated-value").text).toBe("synthetic-unrelated-value");
  });

  it("removes hidden blocks, environment dumps and provider internals at any depth", () => {
    const output = captureHistory({
      content: [
        { type: "thinking", text: "hidden-block" },
        { type: "reasoning", summary: "hidden-summary" },
        { role: "system", content: "hidden-instruction" },
        { type: "text", text: "public answer" }
      ],
      systemPrompt: "hidden-prompt",
      providerMetadata: { raw: "hidden-provider" },
      response_metadata: { data: "hidden-response" },
      environment: { arbitrary: "hidden-env" },
      nested: { reasoning_content: "hidden-reasoning" }
    });
    expect(output.text).not.toContain("hidden-");
    expect(output.text).toContain("public answer");
    expect(output).toMatchObject({ omitted: true, incomplete: true, redacted: false });
    expect(output.reasons).toContain("hidden_content");
    expect(captureHistory(process.env).text).toBe("[OMITTED]");
  });

  it("omits cyclic, binary, proxy and unsupported values without evaluating hooks", () => {
    const cycle: Record<string, unknown> = { ok: "retained" };
    cycle.self = cycle;
    expect(captureHistory(cycle).reasons).toContain("cycle");
    for (const binary of [
      Buffer.from("synthetic-binary"),
      new Uint8Array(10),
      new ArrayBuffer(2),
      new SharedArrayBuffer(2)
    ])
      expect(captureHistory(binary).reasons).toContain("binary");
    const trap = vi.fn(() => {
      throw new Error("trap called");
    });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [proxy, revoked.proxy])
      expect(captureHistory(input).reasons).toContain("proxy");
    expect(trap).not.toHaveBeenCalled();
    const hook = vi.fn(() => "synthetic-to-json");
    expect(captureHistory({ toJSON: hook }).text).not.toContain("synthetic-to-json");
    expect(hook).not.toHaveBeenCalled();
    for (const input of [1n, Symbol("private"), Infinity, undefined, new Date()])
      expect(captureHistory(input).reasons).toContain("unsupported");
    const error = captureHistory(new Error("Authorization: Bearer synthetic-error"));
    expect(error.text).not.toContain("synthetic-error");
    expect(error.text).not.toContain("stack");
  });

  it("stops at depth 12 and bounds wide arrays and objects including excluded keys", () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 12; depth++) deep = { child: deep };
    expect(captureHistory(deep).incomplete).toBe(false);
    expect(captureHistory({ child: deep }).reasons).toContain("traversal_limit");
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 10000; i++) wide[`thinking${i}`] = "excluded";
    wide.tail = "must-not-reach-tail";
    const captured = captureHistory(wide);
    expect(captured.reasons).toContain("traversal_limit");
    expect(captured.text).not.toContain("must-not-reach-tail");
    expect(captureHistory(new Array(1_000_000)).reasons).toContain("traversal_limit");
    expect(
      captureHistory(
        Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), false]))
      ).reasons
    ).toContain("traversal_limit");
  });

  it("omits an oversized field entirely before clipping and retains safe siblings", () => {
    const secret = "synthetic-boundary-secret";
    vi.stubEnv("MINIMAX_API_KEY", secret);
    const output = captureHistory({ safe: "retained", large: "x".repeat(65530) + secret });
    expect(output.text).toContain("retained");
    expect(output.text).not.toContain("xxxx");
    expect(output.text).not.toContain("synthetic-");
    expect(output).toMatchObject({ truncated: true, omitted: true, incomplete: true });
    const clipped = captureHistory('"'.repeat(32760) + secret + "tail");
    expect(clipped.redacted).toBe(true);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).not.toContain("synthetic-");
  });

  it("enforces total serialized UTF-8 bytes, accounting for escaping and emoji boundaries", () => {
    for (const value of [
      "x".repeat(65536),
      '"'.repeat(65536),
      "\\".repeat(65536),
      "\u0000".repeat(20000),
      "😀".repeat(16384),
      { text: '"'.repeat(32000) }
    ]) {
      const captured = captureHistory(value);
      expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(65536);
      expect(captured.capturedBytes).toBe(Buffer.byteLength(captured.text));
      expect(captured.text.isWellFormed()).toBe(true);
      expect(parseHistory(CaptureEnvelopeSchema, captured)).toEqual(captured);
    }
    const full = captureHistory("x".repeat(65536));
    expect(Buffer.byteLength(JSON.stringify(full))).toBe(65536);
    expect(captureHistory("😀".repeat(16385)).text).toBe("[OMITTED]");
    expect(() => parseHistory(CaptureEnvelopeSchema, { ...full, capturedBytes: 0 })).toThrow();
    expect(() =>
      parseHistory(CaptureEnvelopeSchema, {
        ...full,
        text: "x".repeat(65536),
        capturedBytes: 65536
      })
    ).toThrow();
  });

  it("caps each metadata string and key at 2 KiB of UTF-8", () => {
    expect(captureHistoryMetadata("é".repeat(1024)).incomplete).toBe(false);
    expect(captureHistoryMetadata("é".repeat(1025)).text).toBe("[OMITTED]");
    const metadata = captureHistoryMetadata({
      good: "kept",
      long: "x".repeat(2049),
      ["z".repeat(2049)]: "unsafe-key"
    });
    expect(metadata.text).toContain("kept");
    expect(metadata.text).not.toContain("unsafe-key");
    expect(metadata.reasons).toContain("size_limit");
    vi.stubEnv("GH_TOKEN", "tiny");
    const expanded = captureHistoryMetadata({ text: "tiny".repeat(512) });
    expect(expanded).toMatchObject({ redacted: true, omitted: true });
    expect(expanded.text).toContain("[OMITTED]");
  });

  it("retains approved provider identity strings in metadata, but omits provider objects", () => {
    const metadata = captureHistoryMetadata({ modelProvider: "minimax", harnessProvider: "pi" });
    expect(JSON.parse(metadata.text)).toEqual({ modelProvider: "minimax", harnessProvider: "pi" });
    expect(metadata.incomplete).toBe(false);
    expect(captureHistoryMetadata({ modelProvider: { response: "private" } }).text).not.toContain(
      "private"
    );
    vi.stubEnv("MINIMAX_API_KEY", "synthetic-provider-secret");
    expect(
      captureHistoryMetadata({ modelProvider: "synthetic-provider-secret" }).text
    ).not.toContain("synthetic-provider-secret");
  });
});
