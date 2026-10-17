import { describe, expect, it } from "vitest";

import {
  assertCandidateChangePolicy,
  candidateDeltaDigest,
  checkpointCandidate,
  freezeProposal,
  proposalDigest,
  restoreCandidate,
  sourceManifestDigest,
  validateProposal
} from "../src/plugins/coding/proposal.js";

const base = [{ path: "index.js", content: "old\n", mode: "100644" as const }];
const input = {
  id: "proposal",
  jobId: "job",
  repository: "owner/repo",
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  task: "Fix it",
  summary: "Fixed",
  createdAt: new Date().toISOString()
};
const checks = [{ command: "node --test", exitCode: 0, output: "passed", truncated: false }];
describe("frozen coding proposals", () => {
  it("uses schema field order for candidate identity", () => {
    const canonical = {
      baselineDigest: "b".repeat(64),
      files: [{ path: "index.js", content: "new\n", mode: "100644" as const }],
      deleted: ["old.js"],
      revision: 1
    };
    const reordered = {
      revision: 1,
      deleted: ["old.js"],
      files: [{ mode: "100644" as const, content: "new\n", path: "index.js" }],
      baselineDigest: "b".repeat(64)
    };

    expect(candidateDeltaDigest(reordered)).toBe(candidateDeltaDigest(canonical));
    expect(candidateDeltaDigest({ ...canonical, revision: 2 })).not.toBe(
      candidateDeltaDigest(canonical)
    );
    expect(
      candidateDeltaDigest({
        ...canonical,
        files: [{ ...canonical.files[0]!, content: "changed\n" }]
      })
    ).not.toBe(candidateDeltaDigest(canonical));
    expect(
      candidateDeltaDigest({
        ...canonical,
        deleted: ["second.js", "old.js"]
      })
    ).not.toBe(
      candidateDeltaDigest({
        ...canonical,
        deleted: ["old.js", "second.js"]
      })
    );
    expect(() => candidateDeltaDigest({ ...canonical, extra: true } as never)).toThrow(
      "invalid_coding_contract"
    );
  });

  it("binds content, destination, requested task and actual checks to approval", () => {
    const proposal = freezeProposal(input, base, [{ ...base[0]!, content: "new\n" }], checks);
    validateProposal(proposal, ["node --test"]);
    expect(proposal.files).toHaveLength(1);
    expect(proposalDigest({ ...proposal, body: "changed" })).not.toBe(proposal.digest);
    expect(() => validateProposal({ ...proposal, files: base }, ["node --test"])).toThrow();
    expect(() => validateProposal(proposal, ["other"])).toThrow();
  });
  it("blocks secret-bearing changes and unsupported paths instead of silently redacting", () => {
    expect(() =>
      freezeProposal(
        input,
        base,
        [{ ...base[0]!, content: "token=ghp_privateExampleValue\n" }],
        checks
      )
    ).toThrow();
    expect(() =>
      freezeProposal(input, base, [{ ...base[0]!, path: "../escape" }], checks)
    ).toThrow();
  });
  it("does not persist credentials embedded in the requested task", () => {
    const proposal = freezeProposal(
      { ...input, task: "Fix token=ghp_privateExampleValue" },
      base,
      [{ ...base[0]!, content: "new\n" }],
      checks
    );
    expect(JSON.stringify(proposal)).not.toContain("ghp_privateExampleValue");
    validateProposal(proposal, ["node --test"]);
  });
  it("blocks verification trust-root changes and repository-specific protected paths", () => {
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test",
      changePolicy: { protectedPaths: ["tests/**"] }
    };
    expect(() =>
      assertCandidateChangePolicy(
        profile,
        [{ path: "package.json", content: '{"scripts":{"test":"node --test"}}', mode: "100644" }],
        [{ path: "package.json", content: '{"scripts":{"test":"true"}}', mode: "100644" }]
      )
    ).toThrow("coding_protected_path_changed");
    expect(() =>
      assertCandidateChangePolicy(
        profile,
        [{ path: "tests/app.test.js", content: "fails", mode: "100644" }],
        [{ path: "tests/app.test.js", content: "passes", mode: "100644" }]
      )
    ).toThrow("coding_protected_path_changed");
    expect(() =>
      assertCandidateChangePolicy(profile, base, [{ ...base[0]!, content: "new\n" }])
    ).not.toThrow();
    expect(() =>
      assertCandidateChangePolicy(
        { ...profile, changePolicy: { allowDependencyChanges: true } },
        [{ path: "package.json", content: "old", mode: "100644" }],
        [{ path: "package.json", content: "new", mode: "100644" }]
      )
    ).not.toThrow();
  });
  it("restores an exact candidate from a bounded baseline-linked delta", () => {
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test"
    };
    const baseline = [...base, { path: "old.js", content: "remove\n", mode: "100644" as const }];
    const candidate = [
      { ...base[0]!, content: "new\n" },
      { path: "added.js", content: "added\n", mode: "100755" as const }
    ];
    const delta = checkpointCandidate(profile, baseline, candidate, 1);
    expect(delta).toMatchObject({
      baselineDigest: sourceManifestDigest(baseline),
      deleted: ["old.js"],
      revision: 1
    });
    expect(restoreCandidate(baseline, delta)).toEqual(
      [...candidate].sort((a, b) => a.path.localeCompare(b.path, "en"))
    );
    expect(() => restoreCandidate([{ ...base[0]!, content: "changed baseline" }], delta)).toThrow(
      "coding_baseline_changed"
    );
  });

  it("applies policy and secret gates before candidate checkpointing", () => {
    const profile = {
      image: `node@sha256:${"a".repeat(64)}`,
      requiredChecks: ["node --test"],
      ignore: [],
      principal: "cli:test",
      changePolicy: { maxChangedFiles: 1 }
    };
    expect(() =>
      checkpointCandidate(
        profile,
        base,
        [
          { ...base[0]!, content: "new\n" },
          { path: "extra.js", content: "new\n", mode: "100644" }
        ],
        1
      )
    ).toThrow("coding_change_policy_blocked");
    expect(() =>
      checkpointCandidate(
        profile,
        base,
        [{ ...base[0]!, content: "password=synthetic-checkpoint-secret\n" }],
        1
      )
    ).toThrow("coding_secret_gate_blocked");
  });
});
