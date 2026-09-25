import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { assertExecutionRepository, authorizeExecution } from "../src/harness/execution-policy.js";
import { definePlugin } from "../src/plugins/manifest.js";
import { defineRegisteredTool } from "../src/tools/registry.js";

const params = { repo: "owner/repo", task: "Fix the test" };
function fixture() {
  const execute = vi.fn(() => ({ result: {}, text: "done" }));
  const raw = defineRegisteredTool({
    pluginName: "coding",
    name: "prepare",
    label: "Prepare",
    description: "Prepare changes",
    parameters: Type.Object({ repo: Type.String(), task: Type.String() }),
    resultSchema: Type.Object({}),
    authority: { target: "read-write", managedState: "read-write", network: "open" },
    requiredCredentials: ["github-publication-write"],
    execute
  });
  const tool = definePlugin({
    manifest: {
      name: "coding",
      displayName: "Coding",
      description: "Isolated coding",
      capabilities: ["coding"],
      authority: { target: "read-write", managedState: "read-write", network: "open" },
      toolDefaults: { requiresApproval: true, allowedSurfaces: ["cli"] },
      tools: [
        {
          name: "prepare",
          label: "Prepare",
          description: "Prepare changes",
          authority: { target: "read-write", managedState: "read-write", network: "open" },
          requiredCredentials: ["github-publication-write"]
        }
      ]
    },
    tools: [raw]
  }).tools[0]!;
  return { tool, execute };
}
describe("execution authority", () => {
  it("enforces manifest approval at execution, even for a directly obtained tool", () => {
    const { tool, execute } = fixture();
    expect(() => tool.execute(params, { surface: "cli" })).toThrow(/authorization/);
    expect(execute).not.toHaveBeenCalled();
  });
  it("permits only the exact authorized tool, principal, surface and arguments", () => {
    const { tool, execute } = fixture();
    const executionAuthority = authorizeExecution({
      principal: "cli:1000",
      allowedPrincipals: ["cli:1000"],
      allowedRepositories: ["owner/repo"],
      repository: "owner/repo",
      surface: "cli",
      toolName: "coding.prepare",
      parameters: params,
      credentialCapabilities: ["github-publication-write"]
    });
    expect(tool.execute(params, { surface: "cli", executionAuthority })).toMatchObject({
      text: "done"
    });
    expect(() =>
      tool.execute({ ...params, repo: "other/repo" }, { surface: "cli", executionAuthority })
    ).toThrow(/authorization/);
    expect(() => tool.execute(params, { surface: "discord", executionAuthority })).toThrow(
      /surface/
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("rejects disallowed identities, targets and copied/model-manufactured grants", () => {
    const { tool } = fixture();
    const input = {
      principal: "discord:123",
      allowedPrincipals: [],
      allowedRepositories: ["owner/repo"],
      repository: "owner/repo",
      surface: "cli" as const,
      toolName: "coding.prepare",
      parameters: params,
      credentialCapabilities: ["github-publication-write"]
    };
    expect(() => authorizeExecution(input)).toThrow(/authorization/);
    const authority = authorizeExecution({ ...input, allowedPrincipals: ["discord:123"] });
    expect(() =>
      tool.execute(params, { surface: "cli", executionAuthority: { ...authority } })
    ).toThrow(/authorization/);
  });

  it("rejects an exact grant that lacks the tool's credential capability", () => {
    const { tool, execute } = fixture();
    const executionAuthority = authorizeExecution({
      principal: "cli:1000",
      allowedPrincipals: ["cli:1000"],
      allowedRepositories: ["owner/repo"],
      repository: "owner/repo",
      surface: "cli",
      toolName: "coding.prepare",
      parameters: params,
      credentialCapabilities: []
    });

    expect(() => tool.execute(params, { surface: "cli", executionAuthority })).toThrow(
      /credential/
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds an opaque grant to its authorized repository", () => {
    const authority = authorizeExecution({
      principal: "cli:1000",
      allowedPrincipals: ["cli:1000"],
      allowedRepositories: ["owner/repo", "owner/other"],
      repository: "owner/repo",
      surface: "cli",
      toolName: "coding.prepare",
      parameters: params,
      credentialCapabilities: ["github-publication-write"]
    });

    expect(() => assertExecutionRepository(authority, "OWNER/REPO")).not.toThrow();
    expect(() => assertExecutionRepository(authority, "owner/other")).toThrow(/repository/);
  });
});
