import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import {
  HistoryDetailResultSchema,
  HistoryListResultSchema,
  parseHistory
} from "../src/harness/history-schemas.js";
import { handleChatMessage } from "../src/surfaces/chat/runner.js";
import { runHistoryCli } from "../src/surfaces/cli/history.js";

it("rejects duplicate flags and misplaced separators before history reads", () => {
  for (const args of [
    ["list", "--json", "--json"],
    ["list", "--limit", "2", "--limit", "3"],
    ["list", "--"],
    ["show", "interaction", "extra"]
  ]) {
    expect(() => runHistoryCli(args)).toThrow();
  }
});

it("inspects CLI and nested chat sweeps through the real CLI without provider calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-cli-e2e-"));
  const home = path.join(root, "state");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const project = path.resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        "--import",
        path.join(project, "node_modules/tsx/dist/loader.mjs"),
        path.join(project, "src/cli.ts"),
        ...args
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          AGENT_OPS_HOME: home,
          MINIMAX_API_KEY: "",
          GITHUB_TOKEN: "",
          GH_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          LOG_LEVEL: "silent"
        }
      }
    );
  for (const [name, value] of Object.entries({
    AGENT_OPS_HOME: home,
    MINIMAX_API_KEY: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    DISCORD_BOT_TOKEN: ""
  }))
    vi.stubEnv(name, value);
  try {
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.test"],
      ["config", "user.name", "Test"]
    ])
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "# Fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    expect(cli("sweep", repo)).toContain("Status: skipped");
    const response = await handleChatMessage(
      {
        platform: "discord",
        applicationId: "test-bot",
        channelId: "test-channel",
        messageId: "test-message",
        userId: "test-user",
        text: "sweep this repository"
      },
      { defaultRepoPath: repo }
    );
    expect(response).toMatchObject({ kind: "message", status: "skipped" });
    const list = parseHistory(
      HistoryListResultSchema,
      JSON.parse(cli("history", "list", "--json"))
    );
    expect(list.interactions).toHaveLength(2);
    expect(list.interactions.map((row) => row.source).sort()).toEqual(["cli", "discord"]);
    const chat = list.interactions.find((row) => row.source === "discord")!;
    const detail = parseHistory(
      HistoryDetailResultSchema,
      JSON.parse(cli("history", "show", chat.id, "--json"))
    );
    expect(detail.found).toBe(true);
    if (!detail.found) throw new Error("missing chat history");
    const child = detail.activity.items.find(
      (item) => item.kind === "run" && item.record.parentRunId !== null
    );
    expect(child).toBeDefined();
    expect(detail.activity.items.some((item) => item.kind === "artifact")).toBe(true);
    expect(
      detail.activity.items.some(
        (item) => item.kind === "message" && item.record.role === "assistant"
      )
    ).toBe(true);
    expect(cli("reports", "latest", repo)).toContain("history/artifacts/");
    expect(cli("runs", "list", repo)).toContain("status=skipped");
    expect(
      parseHistory(HistoryListResultSchema, JSON.parse(cli("history", "list", "--json")))
        .interactions
    ).toHaveLength(2);
    expect(fs.existsSync(path.join(home, "targets"))).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
