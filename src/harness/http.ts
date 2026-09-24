import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { request as undiciRequest, type Dispatcher } from "undici";

export interface BoundedHttpLimits {
  headerBytes: number;
  encodedBytes: number;
  decodedBytes: number;
  jsonNodes: number;
  jsonDepth: number;
  redirects: number;
}

export interface BoundedJsonRequestOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  limits?: Partial<BoundedHttpLimits>;
  request?: typeof undiciRequest;
}

export interface BoundedJsonResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  data: unknown;
}

const DEFAULT_LIMITS: BoundedHttpLimits = {
  headerBytes: 32 * 1024,
  encodedBytes: 1024 * 1024,
  decodedBytes: 2 * 1024 * 1024,
  jsonNodes: 20_000,
  jsonDepth: 64,
  redirects: 2
};

export async function requestBoundedJson(
  rawUrl: string,
  options: BoundedJsonRequestOptions
): Promise<BoundedJsonResponse> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const request = options.request ?? undiciRequest;
  const initialUrl = validatedUrl(rawUrl);
  const allowedOrigin = initialUrl.origin;
  const controller = new AbortController();
  const deadline = Date.now() + options.timeoutMs;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("http_request_timeout")),
    options.timeoutMs
  );

  try {
    if (options.signal?.aborted) throw new Error("http_request_aborted");
    let url = initialUrl;

    for (let redirects = 0; ; redirects += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("http_request_timeout");

      const response = await abortable(
        request(url, {
          method: "GET",
          headers: options.headers,
          signal: controller.signal,
          maxRedirections: 0,
          headersTimeout: remainingMs,
          bodyTimeout: remainingMs
        }),
        controller.signal
      );
      const headers = responseHeaders(response.headers);
      enforceHeaderLimit(response.headers, limits.headerBytes);

      if (isRedirect(response.statusCode)) {
        response.body.destroy();
        if (redirects >= limits.redirects) throw new Error("http_redirect_limit");
        const location = headers.get("location");
        if (!location) throw new Error("http_redirect_missing_location");
        url = validatedRedirect(location, url, allowedOrigin);
        continue;
      }

      const data = await readJsonBody(response.body, headers, limits, controller.signal);
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers,
        data
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("http_request_failed"));
      }
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("http_request_aborted");
}

function validatedUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("http_url_protocol");
  }
  if (url.username || url.password) throw new Error("http_url_credentials");
  return url;
}

function validatedRedirect(location: string, current: URL, allowedOrigin: string): URL {
  const url = validatedUrl(new URL(location, current).href);
  if (url.origin !== allowedOrigin) throw new Error("http_redirect_origin");
  return url;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function responseHeaders(headers: Dispatcher.ResponseData["headers"]): Headers {
  const projected = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) projected.append(name, item);
    } else if (value !== undefined) {
      projected.set(name, value);
    }
  }
  return projected;
}

function enforceHeaderLimit(headers: Dispatcher.ResponseData["headers"], maxBytes: number): void {
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    bytes += Buffer.byteLength(name);
    if (Array.isArray(value)) {
      for (const item of value) bytes += Buffer.byteLength(item);
    } else if (value !== undefined) {
      bytes += Buffer.byteLength(value);
    }
    if (bytes > maxBytes) throw new Error("http_response_headers_too_large");
  }
}

async function readJsonBody(
  body: Readable,
  headers: Headers,
  limits: BoundedHttpLimits,
  signal: AbortSignal
): Promise<unknown> {
  const contentLength = parseContentLength(headers.get("content-length"));
  if (contentLength !== undefined && contentLength > limits.encodedBytes) {
    body.destroy();
    throw new Error("http_response_encoded_too_large");
  }

  const chunks: Buffer[] = [];
  const encodedLimiter = byteLimitTransform(
    limits.encodedBytes,
    "http_response_encoded_too_large"
  );
  const decodedCollector = byteLimitTransform(
    limits.decodedBytes,
    "http_response_decoded_too_large",
    chunks
  );
  const decoder = contentDecoder(headers.get("content-encoding"));

  try {
    await pipeline(
      decoder
        ? [body, encodedLimiter, decoder, decodedCollector]
        : [body, encodedLimiter, decodedCollector],
      { signal }
    );
  } catch (error) {
    body.destroy();
    throw error;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  const data = JSON.parse(text) as unknown;
  enforceJsonShape(data, limits);
  return data;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("http_content_length_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("http_content_length_invalid");
  return parsed;
}

function contentDecoder(encodingHeader: string | null): Transform | undefined {
  const encoding = encodingHeader?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return undefined;
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new Error("http_content_encoding_unsupported");
}

function byteLimitTransform(maxBytes: number, errorCode: string, chunks?: Buffer[]): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(errorCode));
        return;
      }
      chunks?.push(buffer);
      callback(null, buffer);
    }
  });
}

function enforceJsonShape(value: unknown, limits: BoundedHttpLimits): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > limits.jsonNodes) throw new Error("http_response_json_too_large");
    if (current.depth > limits.jsonDepth) throw new Error("http_response_json_too_deep");
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}
