import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  createChatRequestContext,
  resolveAuthenticatedRequestTarget
} from "../src/surfaces/chat/request-context.js";
import {
  CLI_TARGET_PROVENANCE,
  discordExplicitTargetProvenance,
  normalizedTargetRef,
  OPERATOR_DEFAULT_TARGET_PROVENANCE,
  parseTargetRef,
  prepareWorkspace,
  safeGitUrlForDisplay,
  TargetRefSchema,
  validateTargetRef,
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
      expect(lease.path.startsWith(agentOpsHome)).toBe(true);
      expect(lease).not.toHaveProperty("statePath");
      expect(fs.existsSync(path.join(agentOpsHome, "targets"))).toBe(false);

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
      cleanupPolicy: "delete",
      cleanup: () => Promise.resolve()
    } satisfies WorkspaceLease);

    expect(summary.origin).toBe(displayOrigin);
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});

describe("workspace target policy", () => {
  it("preserves distinct target provenance through normalization and persistence", () => {
    const repoPath = gitRepo();
    const targets = [
      normalizedTargetRef(parseTargetRef(repoPath)),
      normalizedTargetRef(parseTargetRef("https://example.com/acme/demo.git")),
      normalizedTargetRef(
        parseTargetRef(
          "https://github.com/acme/demo.git",
          undefined,
          discordExplicitTargetProvenance()
        )
      ),
      normalizedTargetRef(parseTargetRef(repoPath, undefined, OPERATOR_DEFAULT_TARGET_PROVENANCE))
    ];

    expect(targets.map((target) => target.provenance.source)).toEqual([
      "cli",
      "cli",
      "discord-explicit",
      "operator-default"
    ]);
    expect(targets.map((target) => target.policy.protocol)).toEqual([
      "local",
      "https",
      "https",
      "local"
    ]);
    expect(targets.map((target) => target.policy.localPathCapability)).toEqual([
      "direct-cli",
      "direct-cli",
      "none",
      "operator-default"
    ]);

    for (const target of targets) {
      expect(Value.Check(TargetRefSchema, target)).toBe(true);
      expect(validateTargetRef(JSON.parse(JSON.stringify(target)))).toEqual(target);
    }
  });

  it("defaults Discord targets to credential-free exact github.com HTTPS", () => {
    const target = parseTargetRef(
      "https://github.com/acme/demo.git",
      "main",
      discordExplicitTargetProvenance()
    );

    expect(target).toEqual({
      kind: "git-url",
      url: "https://github.com/acme/demo.git",
      ref: "main",
      provenance: { source: "discord-explicit", exactHost: "github.com" },
      policy: {
        protocol: "https",
        exactHost: "github.com",
        allowRedirects: false,
        allowSecondaryFetches: false,
        localPathCapability: "none"
      }
    });
  });

  it.each([
    ["credentials", "https://user:secret@github.com/acme/demo.git", undefined],
    ["ambiguous HTTPS", "https:github.com/acme/demo.git", undefined],
    ["SCP syntax", "git@github.com:acme/demo.git", undefined],
    ["HTTP", "http://github.com/acme/demo.git", undefined],
    ["lookalike host", "https://github.com.evil.example/acme/demo.git", undefined],
    ["custom port", "https://github.com:8443/acme/demo.git", undefined],
    ["query", "https://github.com/acme/demo.git?ref=main", undefined],
    ["fragment", "https://github.com/acme/demo.git#main", undefined],
    ["IP literal", "https://127.0.0.1/acme/demo.git", undefined],
    ["option-shaped ref", "https://github.com/acme/demo.git", "--upload-pack=marker"]
  ])("rejects Discord %s before transport work", (_case, input, ref) => {
    expect(() => parseTargetRef(input, ref, discordExplicitTargetProvenance())).toThrow();
  });

  it("rejects local paths without a provenance capability", () => {
    expect(() =>
      parseTargetRef("/tmp/demo", undefined, discordExplicitTargetProvenance())
    ).toThrow();
    expect(() =>
      parseTargetRef("/tmp/demo", undefined, {
        source: "operator-default",
        localPathCapability: "none"
      } as never)
    ).toThrow();
  });

  it("rejects persisted targets whose policy was widened or no longer matches", () => {
    const target = parseTargetRef(
      "https://github.com/acme/demo.git",
      undefined,
      discordExplicitTargetProvenance()
    );

    expect(() =>
      validateTargetRef({ ...target, policy: { ...target.policy, allowRedirects: true } })
    ).toThrow();
    expect(() =>
      validateTargetRef({ ...target, policy: { ...target.policy, exactHost: "example.com" } })
    ).toThrow();
    expect(() => validateTargetRef({ ...target, provenance: CLI_TARGET_PROVENANCE })).toThrow();
  });

  it("binds chat work to the authenticated request-context target", () => {
    const request = createChatRequestContext(
      "sweep --repo https://github.com/acme/demo.git --ref main",
      { defaultRepoPath: "/operator/default" }
    );

    expect(request.repositoryTarget).toMatchObject({
      kind: "git-url",
      provenance: { source: "discord-explicit" },
      policy: { exactHost: "github.com", allowRedirects: false }
    });
    expect(
      resolveAuthenticatedRequestTarget(request, "https://github.com/attacker/replacement.git")
    ).toEqual(request.repositoryTarget);

    const operatorDefault = createChatRequestContext("sweep this repository", {
      defaultRepoPath: "/operator/default"
    });
    expect(operatorDefault.repositoryTarget).toMatchObject({
      kind: "local-git",
      provenance: { source: "operator-default" },
      policy: { localPathCapability: "operator-default" }
    });
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
