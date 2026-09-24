import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import { renderReportEnvelope, writeSweepReport } from "../src/tools/report.js";
import { ensureBenchmarkReportSection } from "../src/plugins/rules-benchmark/report.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps full reports intact while redacting configured credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "history-report-"));
  vi.stubEnv("AGENT_OPS_HOME", home);
  vi.stubEnv("MINIMAX_API_KEY", "synthetic-report-credential");
  try {
    openHistoryStore().close();
    const markdown = `# Agent Readiness Sweep\n${"Evidence. ".repeat(9000)}\nsynthetic-report-credential\nEND`;
    const reportPath = writeSweepReport(1, markdown);
    const report = fs.readFileSync(reportPath, "utf8");
    expect(report).toBe(markdown.replace("synthetic-report-credential", "[REDACTED]"));
    expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("guarantees benchmark status and authority without duplicating the section", () => {
  const result = ensureBenchmarkReportSection(
    "## Overall Judgment\n\nReady.\n\n## Agent Rules Benchmark\n\n### Relevant Pattern\n\nUseful comparison.",
    {
      status: "stale",
      provenance: {
        api_version: 1,
        endpoint: "/catalog",
        fetched_at: "2026-09-24T12:00:00.000Z",
        cache_age_ms: 86_400_000
      },
      data: {
        version: 1,
        scope: "Public snapshots.",
        totals: { projects: 100, skills: 1214, patterns: 14 },
        languages: [],
        links: {
          projects: "https://ossrules.md/api/v1/projects",
          skills: "https://ossrules.md/api/v1/skills",
          patterns: "https://ossrules.md/api/v1/patterns"
        },
        queries: {
          projects: [],
          skills: [],
          defaults: { limit: 10, offset: 0 },
          maxLimit: 50,
          matching: "Exact filters.",
          pagination: "Offset pagination."
        }
      },
      unavailable_reason: "http_request_timeout"
    }
  );

  expect(result.match(/^## Agent Rules Benchmark$/gm)).toHaveLength(1);
  expect(result).toContain("Status: `stale`");
  expect(result).toContain("repository-authored rules are authoritative");
  expect(result).toContain("### Relevant Pattern");
});

it("identifies the target without exposing the disposable workspace path", () => {
  const report = renderReportEnvelope("/tmp/agent-workspace", "## Overall Judgment\n\nReady.", {
    workspace: {
      id: "lease-test",
      source: "remote-git",
      origin: "https://github.com/example/repository",
      displayOrigin: "https://github.com/example/repository",
      ref: "main",
      commitSha: "0123456789abcdef",
      path: "/tmp/agent-workspace",
      cleanupPolicy: "delete"
    }
  });

  expect(report).toContain("Repository: `https://github.com/example/repository`");
  expect(report).toContain("Commit: `0123456789abcdef`");
  expect(report).not.toContain("/tmp/agent-workspace");
  expect(report).not.toContain("Workspace:");
});
