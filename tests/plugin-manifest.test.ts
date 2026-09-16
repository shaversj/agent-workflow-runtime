import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import {
  definePlugin,
  definePluginManifest,
  PluginManifestValidationError,
  PluginToolManifestError,
  type AgentOpsPluginManifest
} from "../src/plugins/manifest.js";
import { githubTools } from "../src/plugins/github/tools.js";
import { readinessTools } from "../src/plugins/readiness/tools.js";
import { defineRegisteredTool } from "../src/tools/registry.js";

describe("plugin manifests", () => {
  it("validates a plugin manifest with distinct authority scopes", () => {
    const manifest = definePluginManifest(pluginManifest());

    expect(manifest.authority).toEqual({
      target: "read-only",
      managedState: "read-write",
      network: "model-provider"
    });
  });

  it("rejects invalid manifest authority values", () => {
    const manifest = {
      ...pluginManifest(),
      authority: {
        target: "execute",
        managedState: "read-write",
        network: "model-provider"
      }
    };

    expect(() => definePluginManifest(manifest)).toThrow(PluginManifestValidationError);
    expect(() => definePluginManifest(manifest)).toThrow(/authority/);
  });

  it("rejects duplicate tool summaries", () => {
    const manifest = pluginManifest({
      tools: [toolSummary("echo"), toolSummary("echo")]
    });

    expect(() => definePlugin({ manifest, tools: [demoTool("echo")] })).toThrow(
      PluginToolManifestError
    );
    expect(() => definePlugin({ manifest, tools: [demoTool("echo")] })).toThrow(/duplicated: echo/);
  });

  it("rejects registered tools without manifest summaries", () => {
    const manifest = pluginManifest({ tools: [] });

    expect(() => definePlugin({ manifest, tools: [demoTool("echo")] })).toThrow(
      /missing tool summaries: echo/
    );
  });

  it("rejects manifest summaries without registered tools", () => {
    const manifest = pluginManifest({ tools: [toolSummary("echo")] });

    expect(() => definePlugin({ manifest, tools: [] })).toThrow(/missing registered tools: echo/);
  });

  it("rejects tools from another plugin", () => {
    const manifest = pluginManifest({ tools: [toolSummary("echo")] });
    const tool = demoTool("echo", "other");

    expect(() => definePlugin({ manifest, tools: [tool] })).toThrow(
      /tool echo belongs to plugin other/
    );
  });

  it("rejects manifest summaries that drift from registered tool labels", () => {
    const manifest = pluginManifest({
      tools: [{ ...toolSummary("echo"), label: "Different Echo" }]
    });

    expect(() => definePlugin({ manifest, tools: [demoTool("echo")] })).toThrow(
      /tool echo label does not match manifest summary/
    );
  });

  it("rejects manifest summaries that drift from registered tool descriptions", () => {
    const manifest = pluginManifest({
      tools: [{ ...toolSummary("echo"), description: "Different description." }]
    });

    expect(() => definePlugin({ manifest, tools: [demoTool("echo")] })).toThrow(
      /tool echo description does not match manifest summary/
    );
  });

  it("rejects registered tools with a conflicting source", () => {
    const manifest = pluginManifest({ tools: [toolSummary("echo")] });
    const tool = demoTool("echo", "demo", {
      id: "other",
      label: "Other"
    });

    expect(() => definePlugin({ manifest, tools: [tool] })).toThrow(
      /tool echo source does not match manifest source/
    );
  });

  it("applies manifest source and policy defaults to readiness tools", () => {
    const toolsByName = new Map(readinessTools.map((tool) => [tool.name, tool]));

    expect(readinessTools.map((tool) => tool.source?.id)).toEqual([
      "readiness",
      "readiness",
      "readiness",
      "readiness",
      "readiness"
    ]);
    expect(readinessTools.map((tool) => tool.exposure)).toEqual([
      "deferred",
      "deferred",
      "deferred",
      "deferred",
      "deferred"
    ]);
    expect(readinessTools.map((tool) => tool.allowedSurfaces)).toEqual([
      ["discord"],
      ["discord"],
      ["cli", "discord"],
      ["discord"],
      ["discord"]
    ]);
    expect(toolsByName.get("run_sweep")?.readOnly).toBe(false);
    expect(toolsByName.get("list_runs")?.readOnly).toBe(true);
    expect(toolsByName.get("read_report")?.requiresApproval).toBe(false);
  });

  it("applies manifest source and policy defaults to GitHub tools", () => {
    expect(githubTools.map((tool) => tool.source?.id)).toEqual([
      "github",
      "github",
      "github",
      "github",
      "github"
    ]);
    expect(githubTools.map((tool) => tool.exposure)).toEqual([
      "deferred",
      "deferred",
      "deferred",
      "deferred",
      "deferred"
    ]);
    expect(githubTools.map((tool) => tool.readOnly)).toEqual([true, true, true, true, true]);
    expect(githubTools.map((tool) => tool.allowedSurfaces)).toEqual([
      ["discord"],
      ["discord"],
      ["discord"],
      ["discord"],
      ["discord"]
    ]);
  });
});

function pluginManifest(overrides: Partial<AgentOpsPluginManifest> = {}): AgentOpsPluginManifest {
  return {
    name: "demo",
    displayName: "Demo",
    description: "Demo plugin.",
    capabilities: ["echo"],
    authority: {
      target: "read-only",
      managedState: "read-write",
      network: "model-provider"
    },
    toolDefaults: {
      exposure: "deferred",
      readOnly: true,
      requiresApproval: false,
      allowedSurfaces: ["discord"]
    },
    tools: [toolSummary("echo")],
    ...overrides
  };
}

function toolSummary(name: string): AgentOpsPluginManifest["tools"][number] {
  return {
    name,
    label: name,
    description: `${name} tool.`
  };
}

function demoTool(
  name: string,
  pluginName = "demo",
  source?: Parameters<typeof defineRegisteredTool>[0]["source"]
) {
  return defineRegisteredTool({
    pluginName,
    name,
    label: name,
    description: `${name} tool.`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    resultSchema: Type.Object({ value: Type.Optional(Type.String()) }),
    source,
    execute(params) {
      return {
        result: params,
        text: "ok"
      };
    }
  });
}
