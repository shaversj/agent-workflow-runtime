import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { openHistoryStore } from "../src/db/index.js";
import { writeSweepReport } from "../src/tools/report.js";

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
