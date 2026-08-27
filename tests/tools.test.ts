import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import {
  listFilesTool,
  readFileTool,
  repoSummaryTool,
  searchFilesTool
} from "../src/tools/repo.js";
import { readinessTools } from "../src/plugins/readiness/tools.js";
import { toPiAgentTools } from "../src/harness/pi-tools.js";
import { submitReportTool } from "../src/tools/report.js";
import { defineRegisteredTool, registeredToolName, ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

describe("repo tools", () => {
  it("lists, reads, and searches repository files", async () => {
    const repoPath = tempRepo();
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n\nRun make check.\n");
    fs.mkdirSync(path.join(repoPath, "docs", "standards"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "docs", "standards", "logging.md"), "Use Pino logs.\n");
    const context = testContext(repoPath);

    const listed = await listFilesTool.execute({ pattern: "*.md" }, context);
    expect(listed.result.files).toContain("README.md");

    const read = await readFileTool.execute({ path: "README.md" }, context);
    expect(read.result.content).toContain("make check");

    const searched = await searchFilesTool.execute({ query: "pino" }, context);
    expect(searched.result.matches[0]?.path).toBe("docs/standards/logging.md");
  });

  it("summarizes readiness evidence in one call", async () => {
    const repoPath = tempRepo();
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n\nRun make check.\n");
    fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "# Agent Instructions\n");
    fs.writeFileSync(path.join(repoPath, "package.json"), '{"scripts":{"check":"vitest"}}\n');
    fs.mkdirSync(path.join(repoPath, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".github", "workflows", "ci.yml"), "name: CI\n");
    fs.mkdirSync(path.join(repoPath, "docs", "standards"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "docs", "standards", "testing.md"), "# Testing\n");
    fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "tests", "demo.test.ts"), "test('demo', () => {})\n");

    const summary = await repoSummaryTool.execute({}, testContext(repoPath));

    expect(summary.result.key_files).toContain("README.md");
    expect(summary.result.evidence_recipe).toBe("repo-summary-tool");
    expect(summary.result.plugin).toBe("readiness");
    expect(summary.result.standard_expectations.map((standard) => standard.category)).toContain(
      "testing"
    );
    expect(summary.result.standards).toContain("docs/standards/testing.md");
    expect(summary.result.ci).toContain(".github/workflows/ci.yml");
    expect(summary.result.tests).toContain("tests/demo.test.ts");
    expect(summary.result.excerpts.some((item) => item.path === "README.md")).toBe(true);
  });

  it("does not read outside the repository", () => {
    const repoPath = tempRepo();
    const context = testContext(repoPath);
    expect(() => readFileTool.execute({ path: "../outside.md" }, context)).toThrow(
      /outside the repository/
    );
  });
});

describe("report tool", () => {
  it("writes the submitted report and terminates the workflow", async () => {
    const repoPath = tempRepo();
    const context = testContext(repoPath);
    const output = await submitReportTool.execute(
      { markdown: "## Overall Judgment\n\nReady." },
      context
    );

    expect(output.terminate).toBe(true);
    expect(fs.readFileSync(context.reportPath, "utf8")).toContain("Ready.");
    expect(output.result.report_path).toBe(context.reportPath);
  });
});

describe("tool registry", () => {
  it("indexes plugin tools by namespaced capability name", () => {
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    expect(registry.get("readiness_run_sweep")).toBeDefined();
    expect(registry.list({ surface: "discord" }).map((tool) => registeredToolName(tool))).toEqual([
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
      defaultRepoPath: "/tmp/demo"
    });

    expect(tools.map((tool) => tool.name)).toContain("readiness_run_sweep");
    expect(tools.find((tool) => tool.name === "readiness_run_sweep")?.parameters).toBeDefined();
  });

  it("forwards execution through the Pi adapter", async () => {
    const context = {
      surface: "discord" as const,
      defaultRepoPath: "/tmp/demo"
    };
    const controller = new AbortController();
    const calls: { params: unknown; context: unknown; signal: unknown }[] = [];
    const tool = defineRegisteredTool({
      pluginName: "demo",
      name: "echo",
      label: "Echo",
      description: "Echo a value.",
      parameters: Type.Object({ value: Type.String() }),
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

    expect(calls).toEqual([{ params: { value: "hello" }, context, signal: controller.signal }]);
    expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
    expect(result.details).toEqual({ echoed: "hello" });
    expect(result.terminate).toBe(true);
  });
});

describe("readiness plugin tools", () => {
  it("reads the latest report and does not terminate the chat turn", async () => {
    const repoPath = tempRepo();
    const reportPath = writeReport(repoPath, "latest.md", "# Latest\n");
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    const latest = await registry
      .get("readiness_get_latest_report")!
      .execute({ repo_path: repoPath }, { surface: "discord" });
    const read = await registry
      .get("readiness_read_report")!
      .execute({ repo_path: repoPath }, { surface: "discord" });

    expect(latest.text).toContain(reportPath);
    expect(latest.terminate).toBe(false);
    expect(read.text).toContain("# Latest");
    expect(read.terminate).toBe(false);
  });

  it("rejects report symlinks that resolve outside the reports directory", () => {
    const repoPath = tempRepo();
    const reportDir = path.join(repoPath, ".agent-readiness", "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    const secretPath = path.join(repoPath, "secret.md");
    fs.writeFileSync(secretPath, "private\n");
    const symlinkPath = path.join(reportDir, "leak.md");
    fs.symlinkSync(secretPath, symlinkPath);
    const registry = new ToolRegistry();
    registry.registerMany(readinessTools);

    expect(() =>
      registry
        .get("readiness_read_report")!
        .execute({ repo_path: repoPath, report_path: symlinkPath }, { surface: "discord" })
    ).toThrow(/outside the readiness reports directory/);
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
        .execute({ repo_path: repoPath }, { surface: "discord" }, controller.signal)
    ).rejects.toThrow(/workflow_aborted/);
    expect(fs.existsSync(path.join(repoPath, ".agent-readiness"))).toBe(false);
  });
});

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
}

function writeReport(repoPath: string, name: string, content: string): string {
  const reportDir = path.join(repoPath, ".agent-readiness", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, name);
  fs.writeFileSync(reportPath, content);
  return reportPath;
}

function testContext(repoPath: string): ToolContext {
  return {
    repoPath,
    reportPath: path.join(repoPath, ".agent-readiness", "reports", "test.md"),
    calls: []
  };
}
