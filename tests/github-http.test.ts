import { Readable } from "node:stream";
import { format as formatUrl } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";
import { request as undiciRequest, type Dispatcher } from "undici";

import { requestBoundedJson } from "../src/plugins/github/http.js";

describe("bounded GitHub JSON requests", () => {
  it("follows same-origin redirects and rejects cross-origin redirects", async () => {
    const sameOrigin = vi.fn((url: URL) =>
      Promise.resolve(
        url.pathname === "/start"
          ? response("", 302, { location: "/final" })
          : response(JSON.stringify({ ok: true }))
      )
    );

    await expect(
      requestBoundedJson("https://api.github.com/start", requestOptions(sameOrigin))
    ).resolves.toMatchObject({ ok: true, data: { ok: true } });
    expect(sameOrigin).toHaveBeenCalledTimes(2);

    await expect(
      requestBoundedJson(
        "https://api.github.com/start",
        requestOptions(() =>
          Promise.resolve(response("", 302, { location: "https://example.com/final" }))
        )
      )
    ).rejects.toThrow("github_redirect_origin");
  });

  it("enforces one deadline while waiting for response headers", async () => {
    const never = new Promise<Dispatcher.ResponseData>(() => undefined);
    await expect(
      requestBoundedJson("https://api.github.com/repos/example/demo", {
        ...requestOptions(() => never),
        timeoutMs: 15
      })
    ).rejects.toThrow("github_request_timeout");
  });

  it("aborts stalled bodies at the same request deadline", async () => {
    const body = new Readable({ read() {} });
    await expect(
      requestBoundedJson("https://api.github.com/repos/example/demo", {
        ...requestOptions(() => Promise.resolve(response(body))),
        timeoutMs: 15
      })
    ).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });

  it("rejects declared and chunked encoded bodies over the encoded limit", async () => {
    await expect(
      requestBoundedJson(
        "https://api.github.com/repos/example/demo",
        requestOptions(() => Promise.resolve(response("{}", 200, { "content-length": "100" })), {
          encodedBytes: 10
        })
      )
    ).rejects.toThrow("github_response_encoded_too_large");

    await expect(
      requestBoundedJson(
        "https://api.github.com/repos/example/demo",
        requestOptions(() => Promise.resolve(response(Readable.from(["12345", "67890", "x"]))), {
          encodedBytes: 10
        })
      )
    ).rejects.toThrow("github_response_encoded_too_large");
  });

  it("limits decoded bytes after decompressing a small encoded response", async () => {
    const compressed = gzipSync(JSON.stringify({ value: "x".repeat(4_096) }));
    await expect(
      requestBoundedJson(
        "https://api.github.com/repos/example/demo",
        requestOptions(
          () =>
            Promise.resolve(
              response(compressed, 200, {
                "content-encoding": "gzip",
                "content-length": compressed.byteLength.toString()
              })
            ),
          { encodedBytes: compressed.byteLength + 1, decodedBytes: 512 }
        )
      )
    ).rejects.toThrow("github_response_decoded_too_large");
  });

  it("limits parsed JSON by node count and depth", async () => {
    await expect(
      requestBoundedJson(
        "https://api.github.com/repos/example/demo",
        requestOptions(() => Promise.resolve(response(JSON.stringify([1, 2, 3]))), {
          jsonNodes: 3
        })
      )
    ).rejects.toThrow("github_response_json_too_large");

    await expect(
      requestBoundedJson(
        "https://api.github.com/repos/example/demo",
        requestOptions(() => Promise.resolve(response(JSON.stringify({ a: { b: true } }))), {
          jsonDepth: 1
        })
      )
    ).rejects.toThrow("github_response_json_too_deep");
  });
});

function requestOptions(
  handler: (url: URL, options?: Dispatcher.RequestOptions) => Promise<Dispatcher.ResponseData>,
  limits: Parameters<typeof requestBoundedJson>[1]["limits"] = {}
): Parameters<typeof requestBoundedJson>[1] {
  const request = (async (url, options) => {
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : formatUrl(url);
    return handler(new URL(requestUrl), options as Dispatcher.RequestOptions);
  }) as typeof undiciRequest;
  return {
    headers: { Accept: "application/json" },
    timeoutMs: 1_000,
    limits,
    request
  };
}

function response(
  body: string | Buffer | Readable,
  statusCode = 200,
  headers: Record<string, string> = {}
): Dispatcher.ResponseData {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...headers },
    body: (body instanceof Readable
      ? body
      : Readable.from([body])) as Dispatcher.ResponseData["body"],
    trailers: {},
    opaque: undefined,
    context: {}
  };
}
