import { Readable } from "node:stream";
import { format as formatUrl } from "node:url";

import { describe, expect, it } from "vitest";
import { request as undiciRequest, type Dispatcher } from "undici";

import { requestBoundedJson } from "../src/harness/http.js";

describe("bounded JSON transport", () => {
  it("returns status, headers, and validated JSON for callers", async () => {
    const result = await requestBoundedJson("https://example.test/data", {
      headers: { Accept: "application/json" },
      timeoutMs: 1_000,
      request: mockRequest(() =>
        response(JSON.stringify({ version: 1 }), 200, { etag: '"catalog-1"' })
      )
    });

    expect(result).toMatchObject({ ok: true, status: 200, data: { version: 1 } });
    expect(result.headers.get("etag")).toBe('"catalog-1"');
  });

  it("rejects credentialed URLs and cross-origin redirects", async () => {
    await expect(
      requestBoundedJson("https://token@example.test/data", {
        headers: {},
        timeoutMs: 1_000,
        request: mockRequest(() => response("{}"))
      })
    ).rejects.toThrow("http_url_credentials");

    await expect(
      requestBoundedJson("https://example.test/data", {
        headers: {},
        timeoutMs: 1_000,
        request: mockRequest(() =>
          response("", 302, { location: "https://other.test/data" })
        )
      })
    ).rejects.toThrow("http_redirect_origin");
  });
});

function mockRequest(
  handler: (url: URL, options?: Dispatcher.RequestOptions) => Dispatcher.ResponseData
): typeof undiciRequest {
  return (async (url, options) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : formatUrl(url);
    return handler(new URL(requestUrl), options as Dispatcher.RequestOptions);
  }) as typeof undiciRequest;
}

function response(
  body: string,
  statusCode = 200,
  headers: Record<string, string> = {}
): Dispatcher.ResponseData {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([body]) as Dispatcher.ResponseData["body"],
    trailers: {},
    opaque: undefined,
    context: {}
  };
}
