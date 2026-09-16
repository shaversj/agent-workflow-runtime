import { describe, expect, it } from "vitest";

import {
  freezeProposal,
  proposalDigest,
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
});
