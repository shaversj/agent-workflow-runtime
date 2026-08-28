import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareWorkspace,
  safeGitUrlForDisplay,
  workspaceSummary
} from "../src/workspaces/index.js";
import type { WorkspaceLease } from "../src/workspaces/index.js";

describe("workspace leases", () => {
  it("prepares a disposable checkout for a local git target", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const lease = prepareWorkspace(repoPath);

      expect(lease.source).toBe("local-git");
      expect(lease.origin).toBe(fs.realpathSync(repoPath));
      expect(lease.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(fs.existsSync(path.join(lease.path, "README.md"))).toBe(true);
      expect(lease.path).not.toBe(repoPath);
      expect(lease.statePath.startsWith(agentOpsHome)).toBe(true);

      await lease.cleanup();
      expect(fs.existsSync(lease.path)).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("uses committed git state instead of uncommitted local files", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    fs.writeFileSync(path.join(repoPath, "UNCOMMITTED.md"), "# Draft\n");

    try {
      const lease = prepareWorkspace(repoPath);

      expect(fs.existsSync(path.join(lease.path, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(lease.path, "UNCOMMITTED.md"))).toBe(false);

      await lease.cleanup();
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("redacts credentialed Git URLs for display metadata", () => {
    const display = safeGitUrlForDisplay(
      "https://token:secret@example.com/org/repo.git?api_key=abc&safe=ok"
    );

    expect(display).toBe(
      "https://[REDACTED]@example.com/org/repo.git?api_key=%5BREDACTED%5D&safe=ok"
    );
    expect(display).not.toContain("token");
    expect(display).not.toContain("secret");
    expect(display).not.toContain("abc");
  });

  it("keeps raw Git URLs out of exported workspace summaries", () => {
    const rawUrl = "https://token:secret@example.com/org/repo.git";
    const displayOrigin = safeGitUrlForDisplay(rawUrl);
    const summary = workspaceSummary({
      id: "lease-test",
      target: { kind: "git-url", url: rawUrl },
      source: "git-url",
      origin: rawUrl,
      displayOrigin,
      ref: "main",
      commitSha: "a".repeat(40),
      path: "/tmp/workspace",
      statePath: "/tmp/state",
      cleanupPolicy: "delete",
      cleanup: () => Promise.resolve()
    } satisfies WorkspaceLease);

    expect(summary.origin).toBe(displayOrigin);
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});

function gitRepo() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
  git(["init"], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "-m", "Initial commit"], repoPath);
  return repoPath;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
