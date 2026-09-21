import crypto from "node:crypto";

import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

import { parseCoding } from "../coding/schemas.js";
import type { CodingProposal } from "../coding/schemas.js";
import type { InteractionRecorder } from "../../harness/interaction.js";

const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const objectSchema = Type.Object({ sha });
const refSchema = Type.Object({ object: objectSchema });
const treeSchema = Type.Object({
  sha,
  truncated: Type.Boolean(),
  tree: Type.Array(
    Type.Object({
      path: Type.String({ maxLength: 512 }),
      mode: Type.String(),
      type: Type.String(),
      sha
    }),
    { maxItems: 10000 }
  )
});
const pullSchema = Type.Object({
  html_url: Type.String({ pattern: "^https://github.com/" }),
  draft: Type.Boolean(),
  head: Type.Object({ sha, ref: Type.String(), repo: Type.Object({ full_name: Type.String() }) }),
  base: Type.Object({ ref: Type.String() }),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  state: Type.String()
});

class PublicationUncertain extends Error {
  constructor() {
    super("coding_publication_uncertain");
  }
}

/** Separate from read-only intelligence; no arbitrary endpoints or generic model-facing write tool. */
export class GitHubPublicationClient {
  private recording?: InteractionRecorder;
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch = fetch
  ) {}
  audit(recording: InteractionRecorder): void {
    this.recording = recording;
  }
  private async request<T extends TSchema>(
    repository: string,
    endpoint: string,
    schema: T,
    signal: AbortSignal,
    body?: unknown,
    allowMissing = false
  ): Promise<Static<T> | undefined> {
    const perform = () =>
      this.performRequest(repository, endpoint, schema, signal, body, allowMissing);
    this.recording?.assertHealthy();
    signal.throwIfAborted();
    return this.recording
      ? this.recording.recordTool(
          {
            name: "github-publication.api",
            source: "github-publication",
            kind: "capability",
            input: { repository, endpoint, method: body === undefined ? "GET" : "POST" }
          },
          perform,
          signal
        )
      : perform();
  }
  private async performRequest<T extends TSchema>(
    repository: string,
    endpoint: string,
    schema: T,
    signal: AbortSignal,
    body?: unknown,
    allowMissing = false
  ): Promise<Static<T> | undefined> {
    const write = body !== undefined;
    try {
      const response = await this.transport(
        `https://api.github.com/repos/${repository}/${endpoint}`,
        {
          method: write ? "POST" : "GET",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
          },
          ...(write ? { body: JSON.stringify(body) } : {})
        }
      );
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("coding_github_publication_denied");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("coding_github_response_invalid");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 8 * 1024 * 1024) throw new Error("coding_github_response_limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return parseCoding(schema, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      // Even a 5xx/invalid successful response can follow a committed remote write.
      if (write) throw new PublicationUncertain();
      if (error instanceof Error && error.message === "coding_github_publication_denied")
        throw error;
      throw new Error("coding_github_publication_read_failed");
    }
  }
  async base(proposal: CodingProposal, signal: AbortSignal): Promise<string> {
    const result = await this.request(
      proposal.repository,
      `git/ref/heads/${encodeURIComponent(proposal.baseBranch)}`,
      refSchema,
      signal
    );
    return result!.object.sha;
  }
  async branch(proposal: CodingProposal, signal: AbortSignal): Promise<string | undefined> {
    return (
      await this.request(
        proposal.repository,
        `git/ref/heads/${encodeURIComponent(proposal.branch)}`,
        refSchema,
        signal,
        undefined,
        true
      )
    )?.object.sha;
  }
  async commit(proposal: CodingProposal, signal: AbortSignal): Promise<string> {
    const repository = proposal.repository;
    const base = await this.request(
      repository,
      `git/commits/${proposal.baseCommit}`,
      Type.Object({ sha, tree: objectSchema }),
      signal
    );
    const original = await this.request(
      repository,
      `git/trees/${base!.tree.sha}?recursive=1`,
      treeSchema,
      signal
    );
    if (original!.truncated) throw new Error("coding_github_tree_limit");
    const expected = new Map(
      original!.tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry])
    );
    const updates: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const file of proposal.files) {
      const digest = gitObjectHash("blob", Buffer.from(file.content));
      const blob = await this.request(repository, "git/blobs", objectSchema, signal, {
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64"
      });
      if (blob!.sha !== digest) throw new Error("coding_github_content_mismatch");
      updates.push({ path: file.path, mode: file.mode, type: "blob", sha: digest });
      expected.set(file.path, { ...updates.at(-1)!, sha: digest });
    }
    for (const path of proposal.deleted) {
      const old = expected.get(path);
      if (!old || old.type !== "blob") throw new Error("coding_github_delete_mismatch");
      updates.push({ path, mode: old.mode, type: "blob", sha: null });
      expected.delete(path);
    }
    const tree = await this.request(repository, "git/trees", objectSchema, signal, {
      base_tree: base!.tree.sha,
      tree: updates
    });
    const actual = await this.request(
      repository,
      `git/trees/${tree!.sha}?recursive=1`,
      treeSchema,
      signal
    );
    if (
      actual!.truncated ||
      actual!.tree.filter((entry) => entry.type !== "tree").length !== expected.size ||
      actual!.tree.some((entry) => {
        if (entry.type === "tree") return false;
        const wanted = expected.get(entry.path);
        return (
          !wanted ||
          wanted.mode !== entry.mode ||
          wanted.sha !== entry.sha ||
          wanted.type !== entry.type
        );
      })
    )
      throw new Error("coding_github_tree_mismatch");
    const message = `Agent Ops job ${proposal.jobId}\n\nProposal: ${proposal.digest}\n`;
    const identity = {
      name: "Agent Workflow Runtime",
      email: "agent-workflow-runtime@users.noreply.github.com",
      date: proposal.createdAt
    };
    const timestamp = Math.floor(Date.parse(proposal.createdAt) / 1000);
    const author = `${identity.name} <${identity.email}> ${timestamp} +0000`;
    const expectedCommit = gitObjectHash(
      "commit",
      Buffer.from(
        `tree ${tree!.sha}\nparent ${proposal.baseCommit}\nauthor ${author}\ncommitter ${author}\n\n${message}`
      )
    );
    const commit = await this.request(
      repository,
      "git/commits",
      Type.Object({
        sha,
        tree: objectSchema,
        parents: Type.Array(objectSchema),
        message: Type.String()
      }),
      signal,
      {
        message,
        tree: tree!.sha,
        parents: [proposal.baseCommit],
        author: identity,
        committer: identity
      }
    );
    if (
      commit!.sha !== expectedCommit ||
      commit!.tree.sha !== tree!.sha ||
      commit!.parents.length !== 1 ||
      commit!.parents[0]!.sha !== proposal.baseCommit ||
      commit!.message.trim() !== message.trim()
    )
      throw new Error("coding_github_commit_mismatch");
    return expectedCommit;
  }
  async createBranch(
    proposal: CodingProposal,
    commitSha: string,
    signal: AbortSignal
  ): Promise<void> {
    const result = await this.request(proposal.repository, "git/refs", refSchema, signal, {
      ref: `refs/heads/${proposal.branch}`,
      sha: commitSha
    });
    if (result!.object.sha !== commitSha) throw new PublicationUncertain();
  }
  async findPull(
    proposal: CodingProposal,
    commitSha: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const head = `${proposal.repository.split("/")[0]}:${proposal.branch}`;
    const list = await this.request(
      proposal.repository,
      `pulls?state=all&head=${encodeURIComponent(head)}&per_page=100`,
      Type.Array(pullSchema, { maxItems: 100 }),
      signal
    );
    if (list!.length >= 100) throw new Error("coding_github_pull_limit");
    if (!list!.length) return undefined;
    if (list!.length !== 1) throw new Error("coding_github_pull_conflict");
    return this.matchPull(list![0]!, proposal, commitSha);
  }
  private matchPull(
    pull: Static<typeof pullSchema>,
    proposal: CodingProposal,
    commitSha: string
  ): string {
    if (
      !pull.draft ||
      pull.state !== "open" ||
      pull.head.sha !== commitSha ||
      pull.head.ref !== proposal.branch ||
      pull.head.repo.full_name.toLowerCase() !== proposal.repository.toLowerCase() ||
      pull.base.ref !== proposal.baseBranch ||
      pull.title !== proposal.title ||
      pull.body !== proposal.body ||
      !pull.html_url.startsWith(`https://github.com/${proposal.repository}/pull/`)
    )
      throw new Error("coding_github_pull_conflict");
    return pull.html_url;
  }
  async createPull(
    proposal: CodingProposal,
    commitSha: string,
    signal: AbortSignal
  ): Promise<string> {
    const pull = await this.request(proposal.repository, "pulls", pullSchema, signal, {
      head: proposal.branch,
      base: proposal.baseBranch,
      title: proposal.title,
      body: proposal.body,
      draft: true
    });
    try {
      return this.matchPull(pull!, proposal, commitSha);
    } catch {
      throw new PublicationUncertain();
    }
  }
}

function gitObjectHash(type: string, bytes: Buffer): string {
  return crypto.createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}
