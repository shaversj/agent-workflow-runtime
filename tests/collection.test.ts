import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectReadinessEvidence } from "../src/collection/readiness.js";
import { readinessCollectionSkill } from "../src/skills/readiness-collection.js";

describe("readiness collection", () => {
  it("collects deterministic evidence without producing findings", () => {
    const repoPath = tempRepo();
    fs.writeFileSync(path.join(repoPath, "README.md"), "# Demo\n\nRun make check.\n");
    fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "# Agent Instructions\n");
    fs.writeFileSync(path.join(repoPath, "package.json"), '{"scripts":{"check":"vitest"}}\n');
    fs.mkdirSync(path.join(repoPath, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".github", "workflows", "ci.yml"), "name: CI\n");
    fs.mkdirSync(path.join(repoPath, "docs", "standards"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "docs", "standards", "logging.md"),
      "# Logging\nUse Pino.\n"
    );
    fs.mkdirSync(path.join(repoPath, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "tests", "demo.test.ts"), "test('demo', () => {})\n");

    const evidence = collectReadinessEvidence(repoPath);

    expect(evidence.collection_skill).toBe(readinessCollectionSkill.name);
    expect(evidence.key_files).toEqual(expect.arrayContaining(["README.md", "AGENTS.md"]));
    expect(evidence.standard_expectations.map((standard) => standard.category)).toContain(
      "logging"
    );
    expect(evidence.standard_expectations.map((standard) => standard.category)).not.toContain(
      "redis"
    );
    expect(evidence.standards).toContain("docs/standards/logging.md");
    expect(evidence.ci).toContain(".github/workflows/ci.yml");
    expect(evidence.tests).toContain("tests/demo.test.ts");
    expect(evidence.excerpts.some((item) => item.path === "README.md")).toBe(true);
    expect(evidence.searches.validation[0]).toMatchObject({
      path: "README.md",
      text: "Run make check."
    });
    expect(evidence.redaction).toMatchObject({
      ignored_file_count: 0,
      ignored_files: [],
      redacted_occurrences: 0
    });
    expect(evidence).not.toHaveProperty("findings");
    expect(evidence).not.toHaveProperty("recommendations");
  });

  it("skips sensitive files and redacts secret-looking values", () => {
    const repoPath = tempRepo();
    fs.writeFileSync(
      path.join(repoPath, "README.md"),
      "# Demo\n\nDATABASE_URL=postgres://user:pass@example.test/app\nMINIMAX_API_KEY=sk-demo\n"
    );
    fs.writeFileSync(path.join(repoPath, ".env"), "DATABASE_URL=postgres://secret\n");
    fs.mkdirSync(path.join(repoPath, "config"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "config", "service.credentials.json"), "{}\n");
    fs.writeFileSync(
      path.join(repoPath, "config", "settings.json"),
      '{ "apiKey": "secret-value", "logging": true }\n'
    );

    const evidence = collectReadinessEvidence(repoPath);
    const packet = JSON.stringify(evidence);

    expect(evidence.redaction.ignored_files).toEqual(
      expect.arrayContaining([".env", "config/service.credentials.json"])
    );
    expect(evidence.key_files).toContain("README.md");
    expect(evidence.key_files).not.toContain(".env");
    expect(packet).toContain("MINIMAX_API_KEY=[REDACTED]");
    expect(evidence.searches.logging[0]?.text).toBe('{ "apiKey": "[REDACTED]", "logging": true }');
    expect(packet).not.toContain("sk-demo");
    expect(packet).not.toContain("secret-value");
    expect(packet).not.toContain("postgres://secret");
  });
});

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-kit-"));
}
