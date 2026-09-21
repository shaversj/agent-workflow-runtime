import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCodingCli } from "../src/surfaces/cli/code.js";
import { parseDiscordCoding, handleDiscordCoding } from "../src/surfaces/chat/discord/coding.js";
import { loadCodingPolicy, codingProfile } from "../src/plugins/coding/config.js";
import { CodingGitHubSource } from "../src/plugins/coding/github-source.js";
import * as coding from "../src/workflows/code.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function discordFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-discord-"));
  homes.push(home);
  vi.stubEnv("AGENT_OPS_HOME", home);
  vi.stubEnv("CODING_ENABLED", "true");
  vi.stubEnv("CODING_ALLOWED_PRINCIPALS", JSON.stringify(["discord:1", "discord:2"]));
  vi.stubEnv(
    "CODING_PROFILES",
    JSON.stringify({
      "owner/repo": {
        image: `node@sha256:${"a".repeat(64)}`,
        requiredChecks: ["node --test"],
        ignore: [],
        principal: "discord:1"
      }
    })
  );
  const reply = vi.fn<(input: unknown) => Promise<{ id: string }>>(() =>
    Promise.resolve({ id: "response" })
  );
  const message = (
    id: string,
    user = "1",
    channel = "channel",
    options: { parentId?: string } = {}
  ) =>
    ({
      id,
      author: { id: user, bot: false },
      guildId: "guild",
      channelId: channel,
      channel: options.parentId
        ? { type: 11, parentId: options.parentId }
        : { type: 0, parentId: null },
      client: { application: { id: "application" }, user: { id: "application" } },
      reply
    }) as unknown as Message;
  return { message, reply };
}

describe("coding surface contracts", () => {
  it("binds confirmations to the initiating human/channel and consumes the intent once", async () => {
    const f = discordFixture();
    vi.spyOn(CodingGitHubSource.prototype, "base").mockResolvedValue("b".repeat(40));
    const prepare = vi
      .spyOn(coding, "prepareCoding")
      .mockRejectedValue(new Error("coding_fixture_stop"));
    await handleDiscordCoding(f.message("prepare"), "code prepare owner/repo main Fix bug");
    const content = f.reply.mock.calls[0]![0] as { content: string };
    const id = /code confirm ([a-z0-9-]+)/.exec(content.content)![1]!;
    await handleDiscordCoding(f.message("wrong-user", "2"), `code confirm ${id}`);
    await handleDiscordCoding(f.message("wrong-channel", "1", "other"), `code confirm ${id}`);
    expect(prepare).not.toHaveBeenCalled();
    await handleDiscordCoding(f.message("confirm"), `code confirm ${id}`);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![4]).toMatchObject({
      expectedBaseCommit: "b".repeat(40),
      conversationKey: "guild:channel"
    });
    await handleDiscordCoding(f.message("confirm-again"), `code confirm ${id}`);
    expect(prepare).toHaveBeenCalledTimes(1);
    for (const call of f.reply.mock.calls)
      expect(call[0]).toMatchObject({ allowedMentions: { parse: [] } });
  });
  it("normalizes a thread and its parent channel to one coding conversation", async () => {
    const f = discordFixture();
    vi.spyOn(CodingGitHubSource.prototype, "base").mockResolvedValue("b".repeat(40));
    const prepare = vi
      .spyOn(coding, "prepareCoding")
      .mockRejectedValue(new Error("coding_fixture_stop"));

    await handleDiscordCoding(
      f.message("prepare", "1", "thread", { parentId: "channel" }),
      "code prepare owner/repo main Fix bug"
    );
    const content = f.reply.mock.calls[0]![0] as { content: string };
    const id = /code confirm ([a-z0-9-]+)/.exec(content.content)![1]!;
    await handleDiscordCoding(f.message("confirm", "1", "channel"), `code confirm ${id}`);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![4]).toMatchObject({ conversationKey: "guild:channel" });
  });
  it("deduplicates Discord requests and denies principals before GitHub acquisition", async () => {
    const f = discordFixture();
    const base = vi.spyOn(CodingGitHubSource.prototype, "base").mockResolvedValue("b".repeat(40));
    const command = "code prepare owner/repo main Fix bug";
    await handleDiscordCoding(f.message("denied", "3"), command);
    expect(base).not.toHaveBeenCalled();
    await handleDiscordCoding(f.message("accepted"), command);
    await handleDiscordCoding(f.message("accepted"), command);
    expect(base).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledTimes(2);
  });
  it("requires explicit repository, base and task; no default target or model approval claims", () => {
    expect(parseCodingCli(["prepare", "owner/repo", "main", "fix", "bug"]).action).toBe("prepare");
    for (const args of [
      ["prepare", "/local/path", "main", "fix"],
      ["prepare", "owner/repo"],
      ["approve", "job"],
      ["approve", "job", "--digest", "wrong"],
      ["show", "../escape"],
      ["prepare", "owner/..", "main", "fix"],
      ["show", "job", "--json", "--json"],
      ["show", "job", "--"],
      ["reject", "job", "--digest"],
      ["approve", "job", "--digest", "a".repeat(64), "--digest", "a".repeat(64)]
    ])
      expect(() => parseCodingCli(args)).toThrow();
    expect(parseDiscordCoding("code prepare owner/repo main fix bug").action).toBe("prepare");
    expect(() => parseDiscordCoding("code approve job yes")).toThrow();
    expect(() => parseDiscordCoding("code confirm job extra claims")).toThrow();
  });
  it("starts disabled and rejects malformed/repository-supplied image configuration", () => {
    expect(loadCodingPolicy({}).enabled).toBe(false);
    expect(loadCodingPolicy({ CODING_PROPOSAL_RETENTION_MS: "60000" }).retentionMs).toBe(60000);
    expect(() => loadCodingPolicy({ CODING_PROPOSAL_RETENTION_MS: "0" })).toThrow();
    expect(() => codingProfile(loadCodingPolicy({}), "discord:1", "owner/repo")).toThrow();
    expect(() => loadCodingPolicy({ CODING_ENABLED: "yes" })).toThrow();
    expect(() =>
      loadCodingPolicy({
        CODING_ENABLED: "true",
        CODING_PROFILES: '{"owner/repo":{"image":"node:latest"}}'
      })
    ).toThrow();
  });
});
