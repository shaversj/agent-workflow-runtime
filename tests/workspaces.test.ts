import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
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
import {
  GitOperationError,
  inspectRepository,
  resolveCommit,
  resolveGitRoot
} from "../src/workspaces/git.js";
import { acquireMirrorLock } from "../src/workspaces/lock.js";
import { targetStorageKey } from "../src/workspaces/storage.js";

describe("workspace leases", () => {
  it("prepares a disposable checkout for a local git target", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const agentOpsHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    process.env.AGENT_OPS_HOME = agentOpsHome;
    const repoPath = gitRepo();

    try {
      const lease = await prepareWorkspace(repoPath);

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
      const lease = await prepareWorkspace(repoPath);

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
  it("maps common HTTPS aliases to one mirror identity", () => {
    const plain = parseTargetRef("https://github.com/acme/demo");
    const suffixed = parseTargetRef("https://github.com/acme/demo.git/");

    expect(targetStorageKey(plain)).toBe(targetStorageKey(suffixed));
  });

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

describe("mirror fencing", () => {
  it("rejects a symlinked cache before opening coordination state", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-lock-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-lock-outside-"));
    fs.symlinkSync(outside, path.join(home, "cache"), "dir");
    process.env.AGENT_OPS_HOME = home;

    try {
      await expect(
        acquireMirrorLock(targetStorageKey(parseTargetRef("https://github.com/acme/demo.git")))
      ).rejects.toThrow("mirror_cache_symlink_denied");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("serializes live owners and advances the fence before publishing", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-lock-"));
    process.env.AGENT_OPS_HOME = home;
    const identity = targetStorageKey(parseTargetRef("https://github.com/acme/demo.git"));

    try {
      const first = await acquireMirrorLock(identity);
      await expect(acquireMirrorLock(identity, { timeoutMs: 100, pollMs: 10 })).rejects.toThrow(
        "mirror_lock_timeout"
      );

      fs.mkdirSync(first.stagingPath);
      expect(first.publish()).toBeUndefined();
      first.release();

      const second = await acquireMirrorLock(identity);
      expect(second.fence).toBe(first.fence + 1);
      expect(second.currentPath).toBe(first.stagingPath);
      fs.mkdirSync(second.stagingPath);
      expect(second.publish()).toBe(first.stagingPath);
      second.release();
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it.each([
    { publish: false, outcome: "removes unpublished staging" },
    { publish: true, outcome: "preserves the published current mirror" }
  ])("recovers a dead same-host owner and $outcome", async ({ publish }) => {
    const originalHome = process.env.AGENT_OPS_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-lock-"));
    process.env.AGENT_OPS_HOME = home;
    const identity = targetStorageKey(parseTargetRef("https://github.com/acme/crash.git"));
    let priorPath: string | undefined;
    if (publish) {
      const seed = await acquireMirrorLock(identity);
      fs.mkdirSync(seed.stagingPath);
      seed.publish();
      priorPath = seed.stagingPath;
      seed.release();
    }
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          const { acquireMirrorLock } = await import("./src/workspaces/lock.ts");
          const lease = await acquireMirrorLock(${JSON.stringify(identity)});
          fs.mkdirSync(lease.stagingPath);
          if (${JSON.stringify(publish)}) lease.publish();
          process.send({ fence: lease.fence, stagingPath: lease.stagingPath });
          setInterval(() => {}, 1000);
        `
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, AGENT_OPS_HOME: home },
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      }
    );

    try {
      const owner = await new Promise<{ fence: number; stagingPath: string }>((resolve, reject) => {
        child.once("message", (message) =>
          resolve(message as { fence: number; stagingPath: string })
        );
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`lock owner exited before ready: ${code}`)));
      });
      expect(fs.existsSync(owner.stagingPath)).toBe(true);
      child.kill("SIGKILL");
      await once(child, "exit");

      const recovered = await acquireMirrorLock(identity, { timeoutMs: 2_000, pollMs: 10 });
      expect(recovered.fence).toBe(owner.fence + 1);
      expect(fs.existsSync(owner.stagingPath)).toBe(publish);
      expect(recovered.currentPath).toBe(publish ? owner.stagingPath : undefined);
      if (priorPath) expect(fs.existsSync(priorPath)).toBe(false);
      expect(recovered.stagingPath).not.toBe(owner.stagingPath);
      recovered.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });
});

describe("hardened Git runner", () => {
  it.each(["flood-stdout", "flood-stderr"])(
    "terminates a %s process at the output bound",
    async (mode) => {
      const fixture = fakeGitFixture(mode);
      try {
        await expect(
          resolveGitRoot(fixture.cwd, { timeoutMs: 2_000, maxOutputBytes: 1_024 })
        ).rejects.toMatchObject({ category: "git_output_limit" });
      } finally {
        fixture.restore();
      }
    }
  );

  it("terminates a stalled process and escalates across its process group", async () => {
    const fixture = fakeGitFixture("ignore-term");
    const started = Date.now();
    try {
      await expect(resolveGitRoot(fixture.cwd, { timeoutMs: 1_000 })).rejects.toMatchObject({
        category: "git_timeout"
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      const childPid = Number(fs.readFileSync(path.join(fixture.cwd, ".fake-git-child"), "utf8"));
      await expectProcessToExit(childPid);
    } finally {
      fixture.restore();
    }
  });

  it("composes caller cancellation with process cleanup", async () => {
    const fixture = fakeGitFixture("stall");
    const controller = new AbortController();
    try {
      const operation = resolveGitRoot(fixture.cwd, {
        signal: controller.signal,
        timeoutMs: 2_000
      });
      controller.abort();
      await expect(operation).rejects.toMatchObject({ category: "git_aborted" });
    } finally {
      fixture.restore();
    }
  });

  it("uses an allowlisted environment and ignores hostile inherited Git variables", async () => {
    const original = process.env.HOSTILE_GIT_VALUE;
    process.env.HOSTILE_GIT_VALUE = "must-not-cross";
    const fixture = fakeGitFixture("capture-env");
    try {
      await resolveGitRoot(fixture.cwd);
      const captured = JSON.parse(
        fs.readFileSync(path.join(fixture.cwd, ".fake-git-env"), "utf8")
      ) as Record<string, unknown>;
      expect(captured).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false"
      });
      expect(captured.hostile).toBeUndefined();
      expect(String(captured.HOME)).toContain("agent-ops-kit-home-");
    } finally {
      restoreEnv("HOSTILE_GIT_VALUE", original);
      fixture.restore();
    }
  });

  it("rejects option-shaped refs before starting Git", async () => {
    const repoPath = gitRepo();
    await expect(resolveCommit(repoPath, "--upload-pack=bad")).rejects.toMatchObject({
      category: "git_ref_invalid"
    });
  });

  it("rejects checkout expansion and unsupported repository features", async () => {
    const repoPath = gitRepo();
    const commit = git(["rev-parse", "HEAD"], repoPath);
    await expect(
      inspectRepository(repoPath, commit, { limits: { checkoutBytes: 1 } })
    ).rejects.toMatchObject({ category: "git_checkout_too_large" });

    fs.writeFileSync(path.join(repoPath, ".gitmodules"), '[submodule "x"]\n\tpath = x\n');
    git(["add", ".gitmodules"], repoPath);
    git(["commit", "-m", "Add unsupported submodule metadata"], repoPath);
    const submoduleCommit = git(["rev-parse", "HEAD"], repoPath);
    await expect(inspectRepository(repoPath, submoduleCommit)).rejects.toMatchObject({
      category: "git_submodules_unsupported"
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

function fakeGitFixture(mode: string): { cwd: string; restore: () => void } {
  const originalPath = process.env.PATH;
  const originalHome = process.env.AGENT_OPS_HOME;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-fake-git-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-fake-bin-"));
  const fixture = path.join(import.meta.dirname, "fixtures", "git", "git");
  const executable = path.join(bin, "git");
  fs.copyFileSync(fixture, executable);
  fs.chmodSync(executable, 0o700);
  fs.writeFileSync(path.join(cwd, ".fake-git-mode"), mode);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
  return {
    cwd,
    restore: () => {
      restoreEnv("PATH", originalPath);
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  };
}

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  throw new GitOperationError("fake_git_descendant_survived");
}
