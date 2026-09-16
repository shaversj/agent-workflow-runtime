import zlib from "node:zlib";

import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { decodeSourceArchive, CodingGitHubSource } from "../src/plugins/coding/github-source.js";

async function archive(entries: { name: string; type?: "file" | "symlink"; content?: string }[]) {
  const pack = tar.pack(),
    chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) =>
    pack.on("end", () => resolve(zlib.gzipSync(Buffer.concat(chunks))))
  );
  for (const entry of entries)
    pack.entry(
      { name: entry.name, type: entry.type ?? "file", linkname: "../../host", mode: 0o644 },
      entry.content ?? ""
    );
  pack.finalize();
  return finished;
}
describe("inert source acquisition", () => {
  it.each(["160000", "120000", "truncated"])(
    "rejects unsupported pinned trees before downloading: %s",
    async (mode) => {
      const transport = vi.fn(() =>
        Promise.resolve(
          Response.json({
            truncated: mode === "truncated",
            tree: [
              {
                path: "dependency",
                type: mode === "160000" ? "commit" : "blob",
                mode,
                sha: "b".repeat(40)
              }
            ]
          })
        )
      );
      const source = new CodingGitHubSource(undefined, transport);
      await expect(
        source.files({ repository: "owner/repo", baseBranch: "main", task: "Fix" }, "a".repeat(40))
      ).rejects.toThrow(/tree_unsupported/);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );
  it("normalizes a pinned GitHub archive without executing or extracting it on the host", async () => {
    const input = await archive([{ name: "owner-repo-sha/app.js", content: "export const x=1" }]);
    expect(await decodeSourceArchive(input)).toEqual([
      { path: "app.js", content: "export const x=1", mode: "100644" }
    ]);
  });
  it("rejects links, traversal and malformed archives", async () => {
    await expect(
      decodeSourceArchive(await archive([{ name: "owner-repo-sha/link", type: "symlink" }]))
    ).rejects.toThrow();
    await expect(
      decodeSourceArchive(await archive([{ name: "owner-repo-sha/../../host", content: "bad" }]))
    ).rejects.toThrow();
    await expect(decodeSourceArchive(Buffer.from("not a gzip"))).rejects.toThrow();
  });
  it("does not forward host credentials to download hosts or unauthorized redirects", async () => {
    const input = await archive([{ name: "repo-sha/app.js", content: "safe" }]);
    const hosts: string[] = [];
    const source = new CodingGitHubSource("private-test-read-key", (url, init) => {
      const request = new Request(url, init);
      hosts.push(request.url);
      if (request.url.startsWith("https://api.github.com/")) {
        expect(request.headers.get("Authorization")).toBe("Bearer private-test-read-key");
        if (request.url.includes("/git/trees/"))
          return Promise.resolve(Response.json({ truncated: false, tree: [] }));
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "https://codeload.github.com/owner/repo/archive" }
          })
        );
      }
      expect(request.headers.has("Authorization")).toBe(false);
      return Promise.resolve(new Response(input));
    });
    expect(
      await source.files(
        { repository: "owner/repo", baseBranch: "main", task: "Fix" },
        "a".repeat(40),
        new AbortController().signal
      )
    ).toHaveLength(1);
    expect(hosts).toHaveLength(3);
    const denied = new CodingGitHubSource("private-test-read-key", () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example/archive" }
        })
      )
    );
    await expect(
      denied.files(
        { repository: "owner/repo", baseBranch: "main", task: "Fix" },
        "a".repeat(40),
        new AbortController().signal
      )
    ).rejects.toThrow();
  });
});
