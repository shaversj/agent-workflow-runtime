import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";

import { defaultPluginTools } from "../src/plugins/index.js";
import { readinessTools } from "../src/plugins/readiness/tools.js";
import { toPiAgentTools } from "../src/harness/pi-tools.js";
import { createCatalogBridgeTools } from "../src/tools/catalog-bridge.js";
import { createToolCatalog } from "../src/tools/catalog.js";
import { runSweepWorkflow } from "../src/workflows/sweep.js";
import {
  defineRegisteredTool,
  registeredToolName,
  type RegisteredTool,
  ToolParameterValidationError,
  ToolResultValidationError,
  ToolRegistry,
  UnvalidatedToolError
} from "../src/tools/registry.js";
import { displayInspectionTarget } from "../src/db/inspection.js";
import { openHistoryStore } from "../src/db/index.js";
import { historyArtifactsPath } from "../src/workspaces/storage.js";
import { createChatRequestContext } from "../src/surfaces/chat/request-context.js";

let testHome: string;
beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "tools-history-"));
  vi.stubEnv("AGENT_OPS_HOME", testHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("tool registry", () => {
  it("indexes plugin tools by namespaced capability name", () => {
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    expect(registry.get("readiness_run_sweep")).toBeDefined();
    expect(registry.list({ surface: "discord" }).map((tool) => registeredToolName(tool))).toEqual([
      "readiness_list_runs",
      "readiness_show_run",
      "readiness_run_sweep",
      "readiness_get_latest_report",
      "readiness_read_report"
    ]);
  });

  it("adapts registered tools into Pi agent tools", () => {
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);
    const tools = toPiAgentTools(registry.list({ surface: "discord" }), {
      surface: "discord",
      requestContext: { sourceText: "sweep this repo", repoTarget: "/tmp/demo" }
    });

    expect(tools.map((tool) => tool.name)).toContain("readiness_run_sweep");
    expect(tools.find((tool) => tool.name === "readiness_run_sweep")?.parameters).toBeDefined();
  });

  it("forwards execution through the Pi adapter", async () => {
    const context = {
      surface: "discord" as const,
      requestContext: { sourceText: "use echo", repoTarget: "/tmp/demo" }
    };
    const controller = new AbortController();
    const calls: { params: unknown; context: unknown; signal: unknown }[] = [];
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Object({ echoed: Type.String() }),
      execute(params, toolContext, signal) {
        calls.push({ params, context: toolContext, signal });
        return {
          result: { echoed: params.value },
          text: `echo:${params.value}`,
          terminate: true
        };
      }
    });

    const [piTool] = toPiAgentTools([tool], context);
    const result = await piTool!.execute("tool-call-1", { value: "hello" }, controller.signal);

    expect(calls).toEqual([
      {
        params: { value: "hello" },
        context: { ...context, providerCallId: "tool-call-1" },
        signal: controller.signal
      }
    ]);
    expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
    expect(result.details).toEqual({ echoed: "hello" });
    expect(result.terminate).toBe(true);
  });

  it("validates tool parameters before local execution", () => {
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Object({ echoed: Type.String() }),
      execute(params) {
        return {
          result: { echoed: params.value },
          text: `echo:${params.value}`
        };
      }
    });

    expect(() => tool.execute({ value: 42 }, { surface: "discord" })).toThrow(
      ToolParameterValidationError
    );
  });

  it("rejects tools that bypass the registered tool wrapper", () => {
    const registry = new ToolRegistry();
    const tool = {
      pluginName: "demo",
      name: "raw",
      label: "Raw",
      description: "Raw tool.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Object({ echoed: Type.String() }),
      execute() {
        return {
          result: { echoed: 42 },
          text: "raw"
        };
      }
    } as unknown as RegisteredTool;

    expect(() => registry.register(tool)).toThrow(UnvalidatedToolError);
  });

  it("validates tool results before returning to the caller", () => {
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
      resultSchema: Type.Object({ echoed: Type.String() }),
      execute() {
        return {
          result: { echoed: 42 },
          text: "bad result"
        };
      }
    });

    expect(() => tool.execute({ value: "hello" }, { surface: "discord" })).toThrow(
      ToolResultValidationError
    );
  });

  it.each([
    null,
    undefined,
    { result: { ok: true } },
    { result: { ok: true }, text: 42 },
    { result: { ok: true }, text: "ok", terminate: "yes" },
    { result: { ok: "yes" }, text: "ok" }
  ])("validates the full result envelope: %j", (output) => {
    const tool = defineRegisteredTool({
      pluginName: "test",
      name: "envelope",
      label: "Envelope",
      description: "Exercise the runtime result boundary.",
      parameters: Type.Object({}),
      resultSchema: Type.Object({ ok: Type.Boolean() }),
      execute: () => output as { result: { ok: boolean }; text: string }
    });
    expect(() => tool.execute({}, { surface: "cli" })).toThrow(ToolResultValidationError);
  });
});

describe("tool catalog", () => {
  it("exposes GitHub and readiness plugin sources by default", () => {
    const catalog = createToolCatalog({
      tools: defaultPluginTools,
      surface: "discord"
    });

    expect(catalog.sourceSummaries.map((source) => source.id)).toEqual(["github", "readiness"]);
    expect(catalog.catalogTools.map((tool) => registeredToolName(tool))).toContain(
      "github_get_repository_context"
    );
    expect(catalog.catalogTools.map((tool) => registeredToolName(tool))).toContain(
      "readiness_run_sweep"
    );
  });

  it("filters enabled plugin sources and exposes deferred tools through the catalog", () => {
    const directTool = demoTool("core", "status", "direct");
    const deferredTool = demoTool("readiness", "run", "deferred");
    const hiddenTool = demoTool("readiness", "hidden", "hidden");
    const otherSourceTool = demoTool("deploy", "release", "deferred");

    const catalog = createToolCatalog({
      tools: [directTool, deferredTool, hiddenTool, otherSourceTool],
      surface: "discord",
      enabledSources: ["readiness"]
    });

    expect(catalog.directTools).toEqual([]);
    expect(catalog.catalogTools.map((tool) => registeredToolName(tool))).toEqual(["readiness_run"]);
    expect(catalog.hiddenTools.map((tool) => registeredToolName(tool))).toEqual([
      "readiness_hidden"
    ]);
    expect(catalog.registry.get("readiness_run")).toBeDefined();
    expect(catalog.registry.get("core_status")).toBeUndefined();
    expect(catalog.registry.get("deploy_release")).toBeUndefined();
  });

  it("lets the model search and execute catalog tools through stable bridge names", async () => {
    const calls: unknown[] = [];
    const readinessRunTool = demoTool("readiness", "run_sweep", "deferred", (params) => {
      calls.push(params);
      return {
        result: { ok: true },
        text: "sweep complete",
        terminate: true
      };
    });
    const [searchTools, executeTool] = createCatalogBridgeTools([readinessRunTool], "discord");

    expect(registeredToolName(searchTools!)).toBe("searchTools");
    expect(registeredToolName(executeTool!)).toBe("executeTool");

    const searchResult = await searchTools!.execute({ query: "sweep" }, { surface: "discord" });
    expect(searchResult.text).toContain("readiness_run_sweep");
    expect(searchResult.text).toContain("parameters");
    expect(JSON.stringify(searchResult.result)).toContain("value");

    const executeResult = await executeTool!.execute(
      { tool_name: "readiness_run_sweep", arguments: { repo_path: "/tmp/demo" } },
      { surface: "discord" }
    );

    expect(calls).toEqual([{ repo_path: "/tmp/demo" }]);
    expect(executeResult.text).toBe("sweep complete");
    expect(executeResult.terminate).toBe(true);
  });
});

describe("readiness plugin tools", () => {
  it("lists and shows readiness runs through structured tools", async () => {
    const originalKey = process.env.MINIMAX_API_KEY;
    const originalHome = process.env.AGENT_OPS_HOME;
    delete process.env.MINIMAX_API_KEY;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    try {
      const sweep = await runSweepWorkflow(repoPath);
      const list = await registry
        .get("readiness_list_runs")!
        .execute({ repo_path: repoPath }, discordRepoContext(repoPath));
      const runRef = (list.result as { runs: { run_ref: string }[] }).runs[0]!.run_ref;
      const show = await registry
        .get("readiness_show_run")!
        .execute({ run_ref: runRef, repo_path: repoPath }, discordRepoContext(repoPath));

      expect(list.text).toContain("status=skipped");
      expect(list.result).toMatchObject({
        count: 1,
        runs: [
          {
            run_id: sweep.runId,
            usage_completeness: "unknown",
            failure_reason: "missing_minimax_api_key"
          }
        ]
      });
      expect(show.result).toMatchObject({
        found: true,
        run: {
          run_ref: runRef,
          tool_call_count: 0,
          workflow_activity_count: 1
        }
      });
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
      restoreEnv("MINIMAX_API_KEY", originalKey);
    }
  });

  it("requires a repository target for Discord run lists and bare run IDs", () => {
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    expect(() => registry.get("readiness_list_runs")!.execute({}, { surface: "discord" })).toThrow(
      /Repository target is required/
    );
    expect(() =>
      registry.get("readiness_show_run")!.execute({ run_ref: "1" }, { surface: "discord" })
    ).toThrow(/Repository target is required/);
  });

  it("reads the latest report and does not terminate the chat turn", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const reportPath = writeReport(repoPath, "latest.md", "# Latest\n");
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    try {
      const latest = await registry
        .get("readiness_get_latest_report")!
        .execute({ repo_path: repoPath }, discordRepoContext(repoPath));
      const read = await registry
        .get("readiness_read_report")!
        .execute({ repo_path: repoPath }, discordRepoContext(repoPath));

      expect(latest.text).toContain(reportPath);
      expect(latest.terminate).toBe(false);
      expect(read.text).toContain("# Latest");
      expect(read.terminate).toBe(false);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("omits optional report metadata when no report exists", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    try {
      const latest = await registry
        .get("readiness_get_latest_report")!
        .execute({ repo_path: repoPath }, discordRepoContext(repoPath));

      expect(latest.result).toEqual({ repo_path: displayInspectionTarget(repoPath), bytes: 0 });
      expect(latest.text).toContain("No readiness reports were found");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("redacts credentialed Git URL targets when no report exists", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoTarget = "https://token:secret@example.com/org/repo.git?api_key=abc";
    const authenticatedTarget = "https://github.com/example/demo";
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    try {
      const latest = await registry
        .get("readiness_get_latest_report")!
        .execute({ repo_path: repoTarget }, discordRepoContext(authenticatedTarget));
      const output = `${latest.text}\n${JSON.stringify(latest.result)}`;

      expect(output).toContain("https://github.com/example/demo");
      expect(output).not.toContain("token");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("abc");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("redacts credentialed Git URL targets in report lookup output", async () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoTarget = "https://token:secret@example.com/org/repo.git?api_key=abc";
    const authenticatedTarget = "https://github.com/example/demo";
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);
    writeReport(authenticatedTarget, "latest.md", "# Latest\n");

    try {
      const latest = await registry
        .get("readiness_get_latest_report")!
        .execute({ repo_path: repoTarget }, discordRepoContext(authenticatedTarget));
      const read = await registry
        .get("readiness_read_report")!
        .execute({ repo_path: repoTarget }, discordRepoContext(authenticatedTarget));

      expect(latest.text).not.toContain("token");
      expect(latest.text).not.toContain("secret");
      expect(latest.text).not.toContain("abc");
      expect(JSON.stringify(latest.result)).toContain("https://github.com/example/demo");
      expect(JSON.stringify(read.result)).not.toContain("token");
      expect(JSON.stringify(read.result)).not.toContain("secret");
      expect(JSON.stringify(read.result)).not.toContain("abc");
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("rejects report symlinks that resolve outside the reports directory", () => {
    const originalHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-home-"));
    const repoPath = gitRepo();
    const reportDir = historyArtifactsPath();
    fs.mkdirSync(reportDir, { recursive: true });
    const secretPath = path.join(repoPath, "secret.md");
    fs.writeFileSync(secretPath, "private\n");
    const symlinkPath = path.join(reportDir, "leak.md");
    fs.symlinkSync(secretPath, symlinkPath);
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    try {
      expect(() =>
        registry
          .get("readiness_read_report")!
          .execute({ repo_path: repoPath, report_path: symlinkPath }, discordRepoContext(repoPath))
      ).toThrow(/registered readiness report/);
    } finally {
      restoreEnv("AGENT_OPS_HOME", originalHome);
    }
  });

  it("does not start a sweep when the signal is already aborted", async () => {
    const repoPath = tempRepo();
    const controller = new AbortController();
    controller.abort();
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    await expect(
      registry
        .get("readiness_run_sweep")!
        .execute({ repo_path: repoPath }, discordRepoContext(repoPath), controller.signal)
    ).resolves.toMatchObject({
      result: { status: "cancelled", error: "workflow_aborted", toolCalls: [] }
    });
    expect(fs.existsSync(path.join(repoPath, ".agent-readiness"))).toBe(false);
  });
});

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
}

function discordRepoContext(repoTarget: string) {
  return {
    surface: "discord" as const,
    requestContext: createChatRequestContext("inspect this repository", {
      defaultRepoPath: repoTarget
    })
  };
}

function writeReport(repoPath: string, name: string, content: string): string {
  const store = openHistoryStore();
  try {
    const accepted = store.acceptInteraction({
      source: "cli",
      kind: "readiness_sweep",
      userMessage: "fixture",
      target: displayInspectionTarget(repoPath)
    });
    const reportPath = path.join(fs.realpathSync(historyArtifactsPath()), name);
    fs.writeFileSync(reportPath, content);
    store.registerArtifact({
      interactionId: accepted.interactionId,
      runId: accepted.runId,
      path: reportPath,
      type: "markdown"
    });
    store.finishRun({ id: accepted.runId, status: "completed" });
    store.finishInteraction({ id: accepted.interactionId, status: "completed" });
    return reportPath;
  } finally {
    store.close();
  }
}

function gitRepo() {
  const repoPath = tempRepo();
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

function demoTool(
  pluginName: string,
  name: string,
  exposure: "direct" | "deferred" | "hidden",
  execute: (params: { value?: string }) => {
    result: unknown;
    text: string;
    terminate?: boolean;
  } = (params) => ({
    result: params,
    text: "ok"
  })
) {
  return defineRegisteredTool({
    pluginName,
    name,
    label: name,
    description: `${pluginName} ${name}`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    resultSchema: Type.Object({
      ok: Type.Optional(Type.Boolean()),
      value: Type.Optional(Type.String())
    }),
    source: {
      id: pluginName,
      label: pluginName
    },
    exposure,
    readOnly: true,
    requiresApproval: false,
    allowedSurfaces: ["discord"],
    execute
  });
}
