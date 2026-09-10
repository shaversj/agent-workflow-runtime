import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectHistoryRequest } from "../src/surfaces/web/http.server.js";
import { readInspector } from "../src/surfaces/web/reader.js";

vi.mock("../src/surfaces/web/reader.js", () => ({
  readInspector: vi.fn(() => ({
    ok: true,
    method: "list",
    data: { store: "absent", interactions: [], nextCursor: null }
  }))
}));

const url = "http://127.0.0.1:3000/api/history";
function request(body = '{"method":"list","options":{}}', headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", ...headers },
    body
  });
}

describe("local history HTTP boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it("returns uncacheable validated reader output to the same origin", async () => {
    const response = await inspectHistoryRequest(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readInspector).toHaveBeenCalledWith({ method: "list", options: {} });
  });
  it.each([
    { Origin: "https://attacker.example" },
    { Origin: "http://127.0.0.1:3001" },
    { "Sec-Fetch-Site": "cross-site" }
  ])("rejects cross-origin authority before reading history: %j", async (headers) => {
    expect((await inspectHistoryRequest(request(undefined, headers))).status).toBe(403);
    expect(readInspector).not.toHaveBeenCalled();
  });
  it("rejects non-loopback hosts even with matching origin", async () => {
    expect(
      (
        await inspectHistoryRequest(
          new Request("http://attacker.example/api/history", {
            method: "POST",
            headers: { Origin: "http://attacker.example" },
            body: "{}"
          })
        )
      ).status
    ).toBe(403);
    expect(readInspector).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized and non-JSON payloads without reading history", async () => {
    expect((await inspectHistoryRequest(request("{"))).status).toBe(400);
    expect((await inspectHistoryRequest(request("x".repeat(16385)))).status).toBe(413);
    expect(
      (await inspectHistoryRequest(request("{}", { "Content-Type": "text/plain" }))).status
    ).toBe(415);
    expect(readInspector).not.toHaveBeenCalled();
  });
});
