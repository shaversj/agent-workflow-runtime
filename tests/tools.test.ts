import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  listFilesTool,
  readFileTool,
  repoSummaryTool,
  searchFilesTool
} from "../src/tools/repo.js";
import { submitReportTool } from "../src/tools/report.js";
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

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
}

function testContext(repoPath: string): ToolContext {
  return {
    repoPath,
    reportPath: path.join(repoPath, ".agent-readiness", "reports", "test.md"),
    calls: []
  };
}
