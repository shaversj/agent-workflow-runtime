import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { AttachmentBuilder, ChannelType } from "discord.js";
import type { Message } from "discord.js";
import tar from "tar-stream";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodingApprovalSchema,
  CodingJobSchema,
  CodingProposalSchema,
  PublicationSchema,
  parseCoding
} from "../src/plugins/coding/schemas.js";
import type { DiscordBotConfig } from "../src/surfaces/chat/discord/config.js";
import type { DockerWorker } from "../src/workspaces/docker.js";

const docker = promisify(execFile);
const baseSha = "a".repeat(40),
  oldTree = "b".repeat(40),
  newTree = "c".repeat(40);
const fixed = "module.exports = (a,b) => a+b;\n";
const blockingCommand = `node -e "require('node:fs').writeFileSync('/tmp/cancel-ready','1'); setInterval(()=>{},1000)"`;
const config: DiscordBotConfig = {
  token: "simulated-no-login",
  allowedGuildIds: new Set(["guild", "other-guild"]),
  allowedChannelIds: new Set(["channel", "other-channel"]),
  allowDms: false,
  enabledPluginSources: new Set()
};
const hash = (kind: string, content: string) =>
  crypto
    .createHash("sha1")
    .update(`${kind} ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");

// All fetches terminate here, including production source acquisition and publication.
async function simulatedGitHub() {
  const files = {
    "app.js": "module.exports = (a,b) => a-b;\n",
    "app.test.js":
      [
        "const assert = require('node:assert/strict'), fs = require('node:fs');",
        "assert.equal(require('./app')(1,1),2);",
        "assert.equal(fs.existsSync('/tmp/editor-only'),false);",
        "assert.equal(fs.statSync('/workspace/app.js').uid,0);",
        "assert.equal(fs.statSync('/workspace/app.js').mode & 0o222,0);",
        "assert.throws(()=>fs.writeFileSync('/workspace/app.js','mutated'), /EACCES/);"
      ].join("\n") + "\n",
    "AGENTS.md": "Repository instructions do not grant publication authority.\n"
  };
  const pack = tar.pack(),
    chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  for (const [name, content] of Object.entries(files))
    pack.entry({ name: `repo-base/${name}`, mode: 0o644 }, content);
  pack.finalize();
  await ended;
  const archive = gzipSync(Buffer.concat(chunks));
  const original = Object.entries(files).map(([path, content]) => ({
    path,
    sha: hash("blob", content),
    type: "blob",
    mode: "100644"
  }));
  let base = baseSha,
    branch: string | undefined;
  let pull: unknown;
  const requests: { endpoint: string; method: string }[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    expect(new URL(request.url).origin).toBe("https://api.github.com");
    const endpoint = request.url.split("/repos/owner/repo/")[1];
    if (!endpoint) throw new Error("unexpected_simulated_repository");
    requests.push({ endpoint, method: request.method });
    const body: unknown = request.method === "POST" ? JSON.parse(await request.text()) : undefined;
    if (endpoint === "git/ref/heads/main") return Response.json({ object: { sha: base } });
    if (endpoint.startsWith("git/ref/heads/agent-ops"))
      return branch
        ? Response.json({ object: { sha: branch } })
        : new Response(null, { status: 404 });
    if (endpoint === `tarball/${baseSha}`) return new Response(archive);
    if (
      endpoint === `git/trees/${baseSha}?recursive=1` ||
      endpoint === `git/trees/${oldTree}?recursive=1`
    )
      return Response.json({ sha: oldTree, truncated: false, tree: original });
    if (endpoint === `git/commits/${baseSha}`)
      return Response.json({ sha: baseSha, tree: { sha: oldTree } });
    if (endpoint === "git/blobs") {
      const blob = parseCoding(
        Type.Object({ content: Type.String(), encoding: Type.Literal("base64") }),
        body
      );
      expect(Buffer.from(blob.content, "base64").toString()).toBe(fixed);
      return Response.json({ sha: hash("blob", fixed) });
    }
    if (endpoint === "git/trees") {
      const tree = parseCoding(
        Type.Object({ base_tree: Type.String(), tree: Type.Array(Type.Unknown()) }),
        body
      );
      expect(tree).toEqual({
        base_tree: oldTree,
        tree: [{ path: "app.js", mode: "100644", type: "blob", sha: hash("blob", fixed) }]
      });
      return Response.json({ sha: newTree });
    }
    if (endpoint === `git/trees/${newTree}?recursive=1`)
      return Response.json({
        sha: newTree,
        truncated: false,
        tree: original.map((file) =>
          file.path === "app.js" ? { ...file, sha: hash("blob", fixed) } : file
        )
      });
    if (endpoint === "git/commits") {
      const identity = Type.Object({
        name: Type.String(),
        email: Type.String(),
        date: Type.String()
      });
      const commit = parseCoding(
        Type.Object({
          author: identity,
          committer: identity,
          tree: Type.String(),
          parents: Type.Array(Type.String()),
          message: Type.String()
        }),
        body
      );
      expect(commit.committer).toEqual(commit.author);
      expect(commit.parents).toEqual([baseSha]);
      expect(commit.tree).toBe(newTree);
      const author = `${commit.author.name} <${commit.author.email}> ${Math.floor(Date.parse(commit.author.date) / 1000)} +0000`;
      return Response.json({
        sha: hash(
          "commit",
          `tree ${commit.tree}\nparent ${baseSha}\nauthor ${author}\ncommitter ${author}\n\n${commit.message}`
        ),
        tree: { sha: newTree },
        parents: [{ sha: baseSha }],
        message: commit.message
      });
    }
    if (endpoint === "git/refs") {
      const ref = parseCoding(Type.Object({ ref: Type.String(), sha: Type.String() }), body);
      expect(branch).toBeUndefined();
      expect(ref.ref).toMatch(/^refs\/heads\/agent-ops\//);
      branch = ref.sha;
      return Response.json({ object: { sha: branch } });
    }
    if (endpoint.startsWith("pulls?")) return Response.json(pull ? [pull] : []);
    if (endpoint === "pulls") {
      const proposed = parseCoding(
        Type.Object({
          draft: Type.Boolean(),
          title: Type.String(),
          body: Type.String(),
          head: Type.String(),
          base: Type.String()
        }),
        body
      );
      expect(proposed.draft).toBe(true);
      expect(proposed.base).toBe("main");
      expect(pull).toBeUndefined();
      pull = {
        html_url: "https://github.com/owner/repo/pull/1",
        draft: true,
        state: "open",
        title: proposed.title,
        body: proposed.body,
        head: { sha: branch, ref: proposed.head, repo: { full_name: "owner/repo" } },
        base: { ref: "main" }
      };
      return Response.json(pull);
    }
    throw new Error(`unexpected_simulated_endpoint:${endpoint}`);
  });
  return {
    transport,
    requests,
    moveBase: () => {
      base = "d".repeat(40);
    }
  };
}

describe.skipIf(!process.env.CODING_TEST_IMAGE)(
  "production Discord entry, real Docker/store, simulated model and Discord/GitHub transports",
  () => {
    let home: string;
    let bot: typeof import("../src/surfaces/chat/discord/bot.js");
    let runtime: typeof import("../src/harness/coding-runtime.js");
    let db: typeof import("../src/db/index.js");
    let workers: typeof import("../src/workspaces/docker.js");
    let github: Awaited<ReturnType<typeof simulatedGitHub>>;
    let editor: ReturnType<typeof vi.spyOn<typeof runtime, "runIsolatedCoding">>;
    let freeze: ReturnType<typeof vi.spyOn<DockerWorker, "freeze">>;
    let started: { worker: DockerWorker; verification: boolean }[];
    let ownedJobIds: Set<string>;
    let inFlight: Promise<void>[];
    let sequence: number;

    function profile(requiredChecks = ["node --test"]) {
      vi.stubEnv(
        "CODING_PROFILES",
        JSON.stringify({
          "owner/repo": {
            image: process.env.CODING_TEST_IMAGE,
            requiredChecks,
            ignore: [],
            principal: "discord:1"
          }
        })
      );
    }
    beforeEach(async () => {
      vi.resetModules();
      home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-discord-entry-"));
      started = [];
      ownedJobIds = new Set();
      inFlight = [];
      sequence = 0;
      vi.stubEnv("AGENT_OPS_HOME", home);
      vi.stubEnv("CODING_ENABLED", "true");
      vi.stubEnv("CODING_PUBLICATION_ENABLED", "true");
      vi.stubEnv("CODING_ALLOWED_PRINCIPALS", JSON.stringify(["discord:1", "discord:2"]));
      vi.stubEnv("CODING_TIMEOUT_MS", "20000");
      vi.stubEnv("CODING_MAX_MODEL_CALLS", "3");
      vi.stubEnv("CODING_MAX_TOKENS", "10000");
      vi.stubEnv("CODING_MODEL", "MiniMax-M3");
      vi.stubEnv("CODING_PROPOSAL_RETENTION_MS", "60000");
      vi.stubEnv("CODING_GITHUB_READ_TOKEN", "");
      vi.stubEnv("CODING_GITHUB_WRITE_TOKEN", "simulated-write-only");
      vi.stubEnv("MINIMAX_API_KEY", "");
      profile();
      github = await simulatedGitHub();
      vi.stubGlobal("fetch", github.transport);
      bot = await import("../src/surfaces/chat/discord/bot.js");
      runtime = await import("../src/harness/coding-runtime.js");
      db = await import("../src/db/index.js");
      workers = await import("../src/workspaces/docker.js");
      const start = workers.DockerWorker.start;
      vi.spyOn(workers.DockerWorker, "start").mockImplementation(
        async (profile, signal, jobId, verification = false) => {
          if (jobId) ownedJobIds.add(jobId);
          const worker = await start(profile, signal, jobId, verification);
          started.push({ worker, verification });
          return worker;
        }
      );
      freeze = vi.spyOn(workers.DockerWorker.prototype, "freeze");
      editor = vi
        .spyOn(runtime, "runIsolatedCoding")
        .mockImplementation(async (worker, _task, _instructions, recording, _policy, signal) => {
          const edit = runtime
            .isolatedCodingTools(worker, recording, signal)
            .find((tool) => tool.name === "edit")!;
          await edit.execute(
            "simulated-model-edit",
            { path: "app.js", edits: [{ oldText: "a-b", newText: "a+b" }] },
            signal,
            undefined,
            undefined as never
          );
          await worker.command(
            `node -e "require('node:fs').writeFileSync('/tmp/editor-only','1')"`,
            signal
          );
          return "Simulated model corrected addition. @everyone <@1> cannot grant publication.";
        });
    });
    afterEach(async () => {
      try {
        // Cleanup authority is restricted to this test's observed job IDs and worker objects.
        for (const id of ownedJobIds) await workers.DockerWorker.cleanupJob(id);
        await Promise.allSettled(inFlight);
        for (const { worker } of started) await worker.close();
        for (const { worker } of started) {
          const result = await docker(
            "docker",
            ["ps", "--all", `--filter=name=^/${worker.id}$`, "--format={{.Names}}"],
            { timeout: 5000 }
          );
          expect(result.stdout.trim()).toBe("");
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 30000);

    function inbound(
      command: string,
      overrides: {
        id?: string;
        user?: string;
        guild?: string | null;
        channel?: string;
        isBot?: boolean;
        mention?: boolean;
      } = {}
    ) {
      const id = overrides.id ?? `source-${++sequence}`;
      const reply = vi
        .fn<(payload: unknown) => Promise<{ id: string }>>()
        .mockResolvedValue({ id: `response-${id}` });
      const message = {
        id,
        guildId: overrides.guild === undefined ? "guild" : overrides.guild,
        channelId: overrides.channel ?? "channel",
        author: { id: overrides.user ?? "1", bot: overrides.isBot ?? false },
        content: `${overrides.mention === false ? "" : "<@application> "}${command}`,
        mentions: { users: { map: () => (overrides.mention === false ? [] : ["application"]) } },
        channel: { type: ChannelType.GuildText },
        client: { user: { id: "application" }, application: { id: "application" } },
        reply
      } as unknown as Message;
      return { message, reply, handle: () => bot.handleDiscordMessage(message, config) };
    }
    function payload(input: unknown) {
      return parseCoding(
        Type.Object({
          content: Type.String(),
          allowedMentions: Type.Object({ parse: Type.Array(Type.String()) }),
          files: Type.Optional(Type.Array(Type.Unknown()))
        }),
        input
      );
    }
    function attachment(input: unknown) {
      const sent = payload(input);
      expect(sent.allowedMentions).toEqual({ parse: [] });
      expect(sent.files).toHaveLength(1);
      const file = sent.files![0];
      expect(file).toBeInstanceOf(AttachmentBuilder);
      if (!(file instanceof AttachmentBuilder) || !Buffer.isBuffer(file.attachment))
        throw new Error("expected_safe_buffer_attachment");
      expect(file.name).toBe("coding-proposal.md");
      return file.attachment.toString("utf8");
    }
    async function confirmation() {
      const request = inbound("code prepare owner/repo main Fix addition");
      await request.handle();
      const content = payload(request.reply.mock.calls[0]![0]).content;
      expect(content).toContain(baseSha);
      const id = /code confirm ([a-z0-9-]+)/.exec(content)![1]!;
      return { request, id };
    }
    async function prepared() {
      const intent = await confirmation();
      const confirm = inbound(`code confirm ${intent.id}`);
      await confirm.handle();
      const jobId = /Started isolated coding job ([a-z0-9-]+)/.exec(
        payload(confirm.reply.mock.calls[0]![0]).content
      )![1]!;
      return {
        ...intent,
        confirm,
        jobId,
        proposal: rows("coding_proposal", CodingProposalSchema)[0]!
      };
    }
    function rows<T extends TSchema>(
      table: "coding_job" | "coding_proposal" | "coding_approval" | "coding_publication",
      schema: T
    ): Static<T>[] {
      const connection = db.openHistoryReadConnection({ home });
      if (!connection) return [];
      try {
        return connection
          .prepare(`SELECT data FROM ${table}`)
          .all()
          .map((raw) => {
            const row = parseCoding(Type.Object({ data: Type.String() }), raw);
            return parseCoding(schema, JSON.parse(row.data));
          });
      } finally {
        connection.close();
      }
    }
    function history(sourceMessageId: string) {
      const reader = db.openHistoryReader({ home })!;
      try {
        const interaction = reader
          .listInteractions(100)
          .find((row) => row.sourceMessageId === sourceMessageId)!;
        expect(interaction).toBeDefined();
        const messages = reader.listMessages(interaction.id);
        const runs = reader.listRuns(interaction.id);
        return {
          interaction,
          runs,
          artifacts: reader.listArtifacts(interaction.id),
          tools: runs.flatMap((run) => reader.listToolCalls(run.id)),
          deliveries: messages.flatMap((message) => reader.listDeliveryAttempts(message.id))
        };
      } finally {
        reader.close();
      }
    }
    const writes = () => github.requests.filter((request) => request.method === "POST");
    async function noContainers() {
      for (const { worker } of started) {
        const result = await docker(
          "docker",
          ["ps", "--all", `--filter=name=^/${worker.id}$`, "--format={{.Names}}"],
          { timeout: 5000 }
        );
        expect(result.stdout.trim()).toBe("");
      }
    }

    it.each([
      ["bot author", { isBot: true }],
      ["wrong guild", { guild: "denied-guild" }],
      ["wrong channel", { channel: "denied-channel" }],
      ["unmentioned guild request", { mention: false }],
      ["disabled DM", { guild: null }]
    ] as const)(
      "rejects %s at actual entry before history, simulated model/transport, or real workers",
      async (_name, overrides) => {
        const message = inbound("code prepare owner/repo main Fix addition", overrides);
        await message.handle();
        expect(message.reply).not.toHaveBeenCalled();
        expect(db.openHistoryReader({ home })).toBeUndefined();
        expect(github.transport).not.toHaveBeenCalled();
        expect(editor).not.toHaveBeenCalled();
        expect(workers.DockerWorker.start).not.toHaveBeenCalled();
      }
    );

    it("denies an unallowed human before simulated source/model or real workers/publication", async () => {
      const message = inbound("code prepare owner/repo main Fix addition", { user: "3" });
      await message.handle();
      expect(payload(message.reply.mock.calls[0]![0]).content).toBe("coding_permission_denied");
      expect(history(message.message.id).interaction.status).toBe("failed");
      expect(github.transport).not.toHaveBeenCalled();
      expect(editor).not.toHaveBeenCalled();
      expect(workers.DockerWorker.start).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });

    it("delivers real preparation/show and exact human digest approval once, with simulated model and Discord/GitHub transports", async () => {
      const { request, id } = await confirmation();
      await request.handle();
      expect(request.reply).toHaveBeenCalledTimes(1);
      expect(github.requests).toHaveLength(1);
      for (const overrides of [
        { user: "2" },
        { channel: "other-channel" },
        { guild: "other-guild" }
      ]) {
        const wrong = inbound(`code confirm ${id}`, overrides);
        await wrong.handle();
        expect(payload(wrong.reply.mock.calls[0]![0]).content).toBe("coding_confirmation_denied");
      }
      expect(editor).not.toHaveBeenCalled();
      expect(workers.DockerWorker.start).not.toHaveBeenCalled();
      const confirm = inbound(`code confirm ${id}`);
      await Promise.all([confirm.handle(), confirm.handle()]);
      expect(confirm.reply).toHaveBeenCalledTimes(2);
      expect(editor).toHaveBeenCalledTimes(1);
      const job = rows("coding_job", CodingJobSchema)[0]!;
      const proposal = rows("coding_proposal", CodingProposalSchema)[0]!;
      expect(job).toMatchObject({
        status: "proposal-ready",
        principal: "discord:1",
        conversationKey: "guild:channel",
        baseCommit: baseSha
      });
      expect(proposal.files).toEqual([{ path: "app.js", content: fixed, mode: "100644" }]);
      expect(proposal.checks).toMatchObject([
        { command: "node --test", exitCode: 0, truncated: false }
      ]);
      expect(started.map(({ verification }) => verification)).toEqual([false, true]);
      expect(started[0]!.worker.id).not.toBe(started[1]!.worker.id);
      expect(freeze).toHaveBeenCalledTimes(1);
      const display = attachment(confirm.reply.mock.calls[1]![0]);
      expect(display).toContain(`Digest: ${proposal.digest}`);
      expect(display).toContain(fixed.trim());
      expect(display).not.toContain(home);
      expect(writes()).toHaveLength(0);
      const again = inbound(`code confirm ${id}`);
      await again.handle();
      expect(payload(again.reply.mock.calls[0]![0]).content).toBe("coding_confirmation_denied");
      const show = inbound(`code show ${job.id}`);
      await show.handle();
      expect(attachment(show.reply.mock.calls[0]![0])).toBe(display);
      for (const overrides of [
        { user: "2" },
        { channel: "other-channel" },
        { guild: "other-guild" }
      ]) {
        const wrong = inbound(`code approve ${job.id} ${proposal.digest}`, overrides);
        await wrong.handle();
        expect(payload(wrong.reply.mock.calls[0]![0]).content).toMatch(
          /coding_(principal|conversation)_denied/
        );
      }
      const wrongDigest = inbound(`code approve ${job.id} ${"f".repeat(64)}`);
      await wrongDigest.handle();
      expect(payload(wrongDigest.reply.mock.calls[0]![0]).content).toBe(
        "coding_approval_unavailable"
      );
      expect(writes()).toHaveLength(0);
      const approve = inbound(`code approve ${job.id} ${proposal.digest}`);
      await approve.handle();
      expect(payload(approve.reply.mock.calls[0]![0]).content).toContain(
        "https://github.com/owner/repo/pull/1"
      );
      const before = github.requests.length;
      await approve.handle();
      const consumed = inbound(`code approve ${job.id} ${proposal.digest}`);
      await consumed.handle();
      expect(payload(consumed.reply.mock.calls[0]![0]).content).toBe("coding_approval_unavailable");
      expect(github.requests).toHaveLength(before);
      expect(writes().map((request) => request.endpoint)).toEqual([
        "git/blobs",
        "git/trees",
        "git/commits",
        "git/refs",
        "pulls"
      ]);
      const publication = rows("coding_publication", PublicationSchema)[0]!;
      expect(publication).toMatchObject({
        jobId: job.id,
        proposalId: proposal.id,
        digest: proposal.digest,
        status: "published",
        prUrl: "https://github.com/owner/repo/pull/1"
      });
      expect(rows("coding_approval", CodingApprovalSchema)).toMatchObject([
        {
          jobId: job.id,
          digest: proposal.digest,
          principal: "discord:1",
          consumed: true,
          runId: publication.runId
        }
      ]);
      const preparation = history(confirm.message.id),
        approval = history(approve.message.id);
      expect(preparation.runs).toMatchObject([
        { status: "completed" },
        { id: job.runId, kind: "coding_prepare", status: "completed" }
      ]);
      expect(preparation.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["coding.acquire_source", "coding.edit", "coding.verify"])
      );
      expect(preparation.artifacts).toMatchObject([{ type: "coding-proposal", runId: job.runId }]);
      expect(fs.readFileSync(preparation.artifacts[0]!.path, "utf8")).toBe(display);
      expect(preparation.deliveries).toMatchObject([
        { status: "acknowledged" },
        { status: "acknowledged" }
      ]);
      expect(approval.runs).toMatchObject([
        { status: "completed" },
        { id: publication.runId, kind: "coding_publish", status: "completed" }
      ]);
      expect(approval.deliveries).toMatchObject([{ status: "acknowledged" }]);
      for (const input of [request, confirm, show, approve, consumed])
        for (const call of input.reply.mock.calls)
          expect(payload(call[0]).allowedMentions).toEqual({ parse: [] });
      await noContainers();
    }, 45000);

    it.each(["expired", "restart"])(
      "loses %s confirmation without source acquisition, simulated model, real workers or writes",
      async (kind) => {
        const { id } = await confirmation();
        if (kind === "expired") {
          const now = Date.now();
          vi.spyOn(Date, "now").mockReturnValue(now + 300001);
        } else {
          vi.resetModules();
          bot = await import("../src/surfaces/chat/discord/bot.js");
        }
        const confirm = inbound(`code confirm ${id}`);
        await confirm.handle();
        expect(payload(confirm.reply.mock.calls[0]![0]).content).toBe("coding_confirmation_denied");
        expect(github.requests).toHaveLength(1);
        expect(editor).not.toHaveBeenCalled();
        expect(started).toHaveLength(0);
        expect(rows("coding_job", CodingJobSchema)).toHaveLength(0);
        expect(writes()).toHaveLength(0);
        expect(history(confirm.message.id).interaction.status).toBe("failed");
      }
    );

    it("refuses changed confirmed base before real workers or simulated model editing", async () => {
      const { id } = await confirmation();
      github.moveBase();
      const confirm = inbound(`code confirm ${id}`);
      await confirm.handle();
      expect(payload(confirm.reply.mock.calls[0]![0]).content).toBe("coding_confirmed_base_moved");
      expect(github.requests.map((request) => request.endpoint)).toEqual([
        "git/ref/heads/main",
        "git/ref/heads/main"
      ]);
      expect(editor).not.toHaveBeenCalled();
      expect(started).toHaveLength(0);
      expect(rows("coding_job", CodingJobSchema)).toHaveLength(0);
      await inbound(`code confirm ${id}`).handle();
      expect(github.requests).toHaveLength(2);
    });

    it("failed simulated initial acknowledgment consumes confirmation without acquisition or real Docker/model editing", async () => {
      const { id } = await confirmation();
      const confirm = inbound(`code confirm ${id}`);
      confirm.reply.mockRejectedValue(new Error("simulated Discord acknowledgment loss"));
      await confirm.handle();
      expect(rows("coding_job", CodingJobSchema)).toMatchObject([
        { status: "failed", reason: "coding_discord_acknowledgment_failed" }
      ]);
      expect(started).toHaveLength(0);
      expect(editor).not.toHaveBeenCalled();
      expect(github.requests).toHaveLength(2);
      expect(history(confirm.message.id)).toMatchObject({
        interaction: { status: "failed" },
        deliveries: [{ status: "uncertain" }, { status: "uncertain" }]
      });
      await confirm.handle();
      await inbound(`code confirm ${id}`).handle();
      expect(github.requests).toHaveLength(2);
      expect(writes()).toHaveLength(0);
    });

    it("failed simulated attachment delivery keeps a real sealed proposal and never replays preparation", async () => {
      const { id } = await confirmation();
      const confirm = inbound(`code confirm ${id}`);
      confirm.reply.mockResolvedValueOnce({ id: "started" }).mockRejectedValueOnce({ status: 413 });
      await confirm.handle();
      const job = rows("coding_job", CodingJobSchema)[0]!;
      expect(job.status).toBe("proposal-ready");
      expect(attachment(confirm.reply.mock.calls[1]![0])).toContain("Status: proposal-ready");
      expect(history(confirm.message.id)).toMatchObject({
        interaction: { status: "completed" },
        deliveries: [{ status: "acknowledged" }, { status: "uncertain" }]
      });
      await confirm.handle();
      await inbound(`code confirm ${id}`).handle();
      expect(confirm.reply).toHaveBeenCalledTimes(2);
      expect(editor).toHaveBeenCalledTimes(1);
      const show = inbound(`code show ${job.id}`);
      await show.handle();
      expect(attachment(show.reply.mock.calls[0]![0])).toContain(
        rows("coding_proposal", CodingProposalSchema)[0]!.digest
      );
      expect(rows("coding_publication", PublicationSchema)).toHaveLength(0);
      expect(writes()).toHaveLength(0);
      await noContainers();
    }, 30000);

    it("failed simulated PR reply delivery leaves one real consumed approval and simulated PR without replay", async () => {
      const { jobId, proposal } = await prepared();
      const approve = inbound(`code approve ${jobId} ${proposal.digest}`);
      approve.reply.mockRejectedValue(new Error("simulated Discord PR reply loss"));
      await approve.handle();
      expect(rows("coding_publication", PublicationSchema)).toMatchObject([
        { status: "published", prUrl: "https://github.com/owner/repo/pull/1" }
      ]);
      expect(history(approve.message.id)).toMatchObject({
        interaction: { status: "completed" },
        deliveries: [{ status: "uncertain" }]
      });
      const count = github.requests.length;
      await approve.handle();
      await inbound(`code approve ${jobId} ${proposal.digest}`).handle();
      expect(github.requests).toHaveLength(count);
      expect(writes().filter((request) => request.endpoint === "pulls")).toHaveLength(1);
      expect(rows("coding_approval", CodingApprovalSchema)).toMatchObject([{ consumed: true }]);
      const show = inbound(`code show ${jobId}`);
      await show.handle();
      expect(payload(show.reply.mock.calls[0]![0]).content).toContain(
        "https://github.com/owner/repo/pull/1"
      );
      await noContainers();
    }, 30000);

    it("moved simulated publication base consumes approval but grants no GitHub writes", async () => {
      const { jobId, proposal } = await prepared();
      github.moveBase();
      const approve = inbound(`code approve ${jobId} ${proposal.digest}`);
      await approve.handle();
      expect(payload(approve.reply.mock.calls[0]![0]).content).toBe("coding_base_moved");
      expect(rows("coding_publication", PublicationSchema)).toMatchObject([
        { status: "publication-uncertain", reason: "coding_base_moved" }
      ]);
      expect(rows("coding_approval", CodingApprovalSchema)).toMatchObject([{ consumed: true }]);
      await inbound(`code approve ${jobId} ${proposal.digest}`).handle();
      expect(writes()).toHaveLength(0);
      await noContainers();
    }, 30000);

    it.each(["failed", "truncated"])(
      "real fresh-worker %s checks refuse human approval with simulated model/transports",
      async (kind) => {
        profile([
          kind === "failed"
            ? "node --test && node -e 'process.exit(1)'"
            : "node --test && node -e 'process.stdout.write(\"x\".repeat(70000))'"
        ]);
        const { jobId, proposal, confirm } = await prepared();
        expect(rows("coding_job", CodingJobSchema)).toMatchObject([{ status: "blocked" }]);
        expect(proposal.checks[0]!.truncated).toBe(kind === "truncated");
        expect(proposal.checks[0]!.exitCode).toBe(kind === "failed" ? 1 : 0);
        expect(attachment(confirm.reply.mock.calls[1]![0])).toContain("Status: blocked");
        const approve = inbound(`code approve ${jobId} ${proposal.digest}`);
        await approve.handle();
        expect(payload(approve.reply.mock.calls[0]![0]).content).not.toContain("published");
        expect(history(approve.message.id).interaction.status).toBe("failed");
        expect(rows("coding_approval", CodingApprovalSchema)).toHaveLength(0);
        expect(rows("coding_publication", PublicationSchema)).toHaveLength(0);
        expect(writes()).toHaveLength(0);
        await noContainers();
      },
      30000
    );

    it.each(["editor", "verifier"])(
      "concurrent human cancellation stops active real %s despite simulated final reply failures",
      async (phase) => {
        if (phase === "editor") {
          editor.mockImplementation(
            async (worker, _task, _instructions, _recording, _policy, signal) => {
              await worker.command(blockingCommand, signal, 15000);
              return "must not seal cancelled work";
            }
          );
        } else profile([blockingCommand]);
        const { id } = await confirmation();
        const confirm = inbound(`code confirm ${id}`);
        confirm.reply
          .mockResolvedValueOnce({ id: "started" })
          .mockRejectedValue(new Error("simulated final reply loss"));
        const running = confirm.handle();
        inFlight.push(running);
        await vi.waitFor(
          async () => {
            const active = started.find(
              ({ verification }) => verification === (phase === "verifier")
            );
            expect(active).toBeDefined();
            const result = await docker(
              "docker",
              [
                "exec",
                active!.worker.id,
                "node",
                "-e",
                "process.exit(require('node:fs').existsSync('/tmp/cancel-ready')?0:1)"
              ],
              { timeout: 3000 }
            );
            expect(result.stderr).toBe("");
          },
          { timeout: 12000, interval: 100 }
        );
        const job = rows("coding_job", CodingJobSchema)[0]!;
        expect(job.status).toBe("preparing");
        for (const overrides of [{ user: "2" }, { channel: "other-channel" }]) {
          await inbound(`code cancel ${job.id}`, overrides).handle();
          expect(rows("coding_job", CodingJobSchema)[0]!.cancelRequested).toBeUndefined();
        }
        const cancel = inbound(`code cancel ${job.id}`);
        cancel.reply.mockRejectedValue(new Error("simulated cancellation reply loss"));
        await cancel.handle();
        await running;
        expect(rows("coding_job", CodingJobSchema)).toMatchObject([
          { id: job.id, status: "interrupted", cancelRequested: true, reason: "coding_cancelled" }
        ]);
        expect(rows("coding_proposal", CodingProposalSchema)).toHaveLength(0);
        expect(history(confirm.message.id)).toMatchObject({
          interaction: { status: "cancelled" },
          runs: [{ status: "cancelled" }, { kind: "coding_prepare", status: "cancelled" }],
          deliveries: [{ status: "acknowledged" }, { status: "uncertain" }]
        });
        expect(history(cancel.message.id)).toMatchObject({
          interaction: { status: "completed" },
          deliveries: [{ status: "uncertain" }]
        });
        expect(started.map(({ verification }) => verification)).toEqual(
          phase === "editor" ? [false] : [false, true]
        );
        expect(writes()).toHaveLength(0);
        await noContainers();
      },
      30000
    );
  }
);
