import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import tar from "tar-stream";
import { Type } from "typebox";
import type { TSchema, Static } from "typebox";

import { parseCoding, CodingTaskSchema } from "./schemas.js";
import type { CodingTask, SourceFile } from "./schemas.js";

const RefSchema = Type.Object({
  object: Type.Object({ sha: Type.String({ pattern: "^[a-f0-9]{40}$" }) })
});
const TreeSchema = Type.Object({
  truncated: Type.Boolean(),
  tree: Type.Array(
    Type.Object({
      path: Type.String(),
      mode: Type.String(),
      type: Type.String(),
      sha: Type.String({ pattern: "^[a-f0-9]{40}$" })
    }),
    { maxItems: 20000 }
  )
});
const headerSchema = Type.Object({
  name: Type.String(),
  type: Type.String(),
  size: Type.Number({ minimum: 0 }),
  mode: Type.Number()
});
const sensitiveFile =
  /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|p12)$/i;

export class CodingGitHubSource {
  constructor(
    private readonly token?: string,
    private readonly transport: typeof fetch = fetch
  ) {}
  async json<T extends TSchema>(
    endpoint: string,
    schema: T,
    signal?: AbortSignal
  ): Promise<Static<T>> {
    const response = await this.transport(`https://api.github.com${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) throw new Error(`coding_github_read_failed:${response.status}`);
    return parseCoding(
      schema,
      JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString("utf8"))
    );
  }
  async base(task: CodingTask, signal?: AbortSignal): Promise<string> {
    parseCoding(CodingTaskSchema, task);
    const result = await this.json(
      `/repos/${task.repository}/git/ref/heads/${encodeURIComponent(task.baseBranch)}`,
      RefSchema,
      signal
    );
    return result.object.sha;
  }
  async files(task: CodingTask, commit: string, signal?: AbortSignal): Promise<SourceFile[]> {
    parseCoding(CodingTaskSchema, task);
    parseCoding(Type.String({ pattern: "^[a-f0-9]{40}$" }), commit);
    // Archives omit gitlinks; inspect the pinned tree before claiming a complete editable snapshot.
    const tree = await this.json(
      `/repos/${task.repository}/git/trees/${commit}?recursive=1`,
      TreeSchema,
      signal
    );
    if (
      tree.truncated ||
      tree.tree.some(
        (entry) =>
          !(
            (entry.type === "tree" && entry.mode === "040000") ||
            (entry.type === "blob" && ["100644", "100755"].includes(entry.mode))
          )
      )
    )
      throw new Error("coding_source_tree_unsupported");
    let url = new URL(`https://api.github.com/repos/${task.repository}/tarball/${commit}`);
    const timeout = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    for (let redirect = 0; redirect < 4; redirect++) {
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["api.github.com", "codeload.github.com"].includes(url.hostname)
      )
        throw new Error("coding_download_host_denied");
      const response = await this.transport(url, {
        redirect: "manual",
        signal: timeout,
        headers:
          url.hostname === "api.github.com" && this.token
            ? { Authorization: `Bearer ${this.token}` }
            : {}
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("coding_download_redirect_invalid");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`coding_download_failed:${response.status}`);
      return decodeSourceArchive(await boundedBody(response, 16 * 1024 * 1024));
    }
    throw new Error("coding_download_redirect_limit");
  }
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("coding_download_empty");
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error("coding_download_limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export function decodeSourceArchive(archive: Buffer): Promise<SourceFile[]> {
  if (archive.length > 16 * 1024 * 1024) return Promise.reject(new Error("coding_download_limit"));
  return new Promise((resolve, reject) => {
    const extract = tar.extract(),
      gunzip = createGunzip(),
      files: SourceFile[] = [],
      paths = new Set<string>();
    let size = 0,
      root: string | undefined;
    const fail = () => {
      gunzip.destroy();
      extract.destroy();
      reject(new Error("coding_archive_invalid"));
    };
    gunzip.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) fail();
    });
    gunzip.on("error", fail);
    extract.on("error", fail);
    extract.on("entry", (rawHeader, stream, next) => {
      try {
        const header = parseCoding(headerSchema, rawHeader);
        const parts = header.name.replace(/\/$/, "").split("/");
        if (
          header.name.startsWith("/") ||
          header.name.includes("\\") ||
          parts.some((part) => ["", ".", ".."].includes(part))
        )
          throw new Error();
        root ??= parts[0];
        if (parts[0] !== root) throw new Error();
        const filePath = parts.slice(1).join("/");
        if (header.type === "directory") {
          stream.resume();
          stream.on("end", next);
          return;
        }
        if (
          header.type !== "file" ||
          !filePath ||
          filePath.length > 512 ||
          paths.has(filePath) ||
          header.size > 1024 * 1024 ||
          paths.size >= 10000
        )
          throw new Error();
        paths.add(filePath);
        if (sensitiveFile.test(filePath) || parts.includes(".git")) {
          stream.resume();
          stream.on("end", next);
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: unknown) => {
          if (!Buffer.isBuffer(chunk)) {
            fail();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          const bytes = Buffer.concat(chunks),
            content = bytes.toString("utf8");
          if (bytes.includes(0) || !Buffer.from(content).equals(bytes)) {
            fail();
            return;
          }
          files.push({ path: filePath, content, mode: header.mode & 0o111 ? "100755" : "100644" });
          next();
        });
      } catch {
        stream.resume();
        fail();
      }
    });
    extract.on("finish", () => {
      if (files.length === 0) fail();
      else resolve(files.sort((a, b) => a.path.localeCompare(b.path)));
    });
    Readable.from(archive).pipe(gunzip).pipe(extract);
  });
}
