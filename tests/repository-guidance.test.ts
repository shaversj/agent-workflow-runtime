import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverRepositoryGuidance,
  isRepositoryGuidanceApplicable
} from "../src/repository-guidance/discovery.js";
import {
  parseRepositoryGuidanceInventory,
  type RepositoryGuidanceSource
} from "../src/repository-guidance/schemas.js";

describe("repository guidance", () => {
  it("discovers supported sources with neutral versioning, scope, and coverage", () => {
    const repo = fixtureRepo({
      "AGENTS.md": "# Root rules\n\nUse pnpm.\n",
      "services/api/AGENTS.md": "# API rules\n",
      "CLAUDE.md": "# Claude\n",
      ".cursor/rules/typescript.mdc":
        "---\nglobs: ['**/*.ts']\n---\n# TypeScript\nUse strict mode.\n",
      ".github/copilot-instructions.md": "# Copilot\n",
      "docs/standards/README.md":
        "# Standards\n\n- [Testing](testing.md)\n- [Logging](logging.md)\n",
      "docs/standards/testing.md": "# Testing\nUse Vitest.\n"
    });

    const result = discoverRepositoryGuidance(repo);

    expect(result.version).toBe(1);
    expect(result).not.toHaveProperty("plugin");
    expect(result.sources.map((source) => source.path)).toEqual([
      ".cursor/rules/typescript.mdc",
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "CLAUDE.md",
      "docs/standards/README.md",
      "docs/standards/testing.md",
      "services/api/AGENTS.md"
    ]);
    expect(result.sources.find((source) => source.path === "AGENTS.md")?.scope).toEqual({
      kind: "repository"
    });
    expect(
      result.sources.find((source) => source.path === "services/api/AGENTS.md")?.scope
    ).toEqual({ kind: "subtree", root: "services/api" });
    expect(
      result.sources.find((source) => source.path === ".cursor/rules/typescript.mdc")?.scope
    ).toEqual({ kind: "path-glob", patterns: ["**/*.ts"] });
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "testing", status: "observed", expected: true }),
        expect.objectContaining({ capability: "logging", status: "missing", expected: true })
      ])
    );
  });

  it("redacts secret-shaped excerpts and bounds inventories", () => {
    const files: Record<string, string> = {
      "AGENTS.md": "# Rules\nMINIMAX_API_KEY=sk-this-is-a-secret-value\n"
    };
    for (let index = 0; index < 90; index += 1) {
      files[`docs/standards/standard-${index}.md`] = `# Standard ${index}\n`;
    }

    const result = discoverRepositoryGuidance(fixtureRepo(files));

    expect(result.sources).toHaveLength(80);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-this-is-a-secret-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("resolves repository, subtree, and cursor glob scopes consistently", () => {
    const sources = [
      source({ kind: "agents", path: "AGENTS.md", scope: { kind: "repository" } }),
      source({
        kind: "agents",
        path: "services/api/AGENTS.md",
        scope: { kind: "subtree", root: "services/api" }
      }),
      source({
        kind: "cursor",
        path: ".cursor/rules/typescript.mdc",
        scope: { kind: "path-glob", patterns: ["**/*.ts"] }
      })
    ];

    expect(isRepositoryGuidanceApplicable(sources[0]!, "README.md")).toBe(true);
    expect(isRepositoryGuidanceApplicable(sources[1]!, "services/api/src/index.ts")).toBe(true);
    expect(isRepositoryGuidanceApplicable(sources[1]!, "services/web/index.ts")).toBe(false);
    expect(isRepositoryGuidanceApplicable(sources[2]!, "src/index.ts")).toBe(true);
    expect(isRepositoryGuidanceApplicable(sources[2]!, "src/index.py")).toBe(false);
  });

  it("rejects malformed inventories at the contract boundary", () => {
    expect(() => parseRepositoryGuidanceInventory({ version: 1, sources: [] })).toThrow(
      "invalid_repository_guidance"
    );
  });
});

function source(input: Pick<RepositoryGuidanceSource, "kind" | "path" | "scope">): RepositoryGuidanceSource {
  return {
    ...input,
    languages: [],
    tools: [],
    excerpt: "",
    truncated: false,
    untrusted: true,
    warnings: []
  };
}

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-guidance-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  return root;
}
