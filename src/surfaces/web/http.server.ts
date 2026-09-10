import { readInspector } from "./reader.js";

function isLocalRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export async function inspectHistoryRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  // A hostile website must not use this local service to read private transcripts.
  if (
    !isLocalRequest(request) ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    (request.headers.has("sec-fetch-site") &&
      request.headers.get("sec-fetch-site") !== "same-origin")
  )
    return new Response("Forbidden", { status: 403, headers });
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return new Response("Expected JSON", { status: 415, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response("Invalid request", { status: 400, headers });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) {
        await reader.cancel();
        return new Response("Request too large", { status: 413, headers });
      }
      chunks.push(value);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return Response.json(readInspector(input), { headers });
  } catch {
    return new Response("Invalid request", { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
}
