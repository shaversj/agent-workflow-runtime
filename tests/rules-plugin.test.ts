import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverRules } from "../src/plugins/rules/discovery.js";
import { rulesTools } from "../src/plugins/rules/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("rules plugin", () => {
  it("discovers supported sources with scope and declared standards coverage", () => {
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

    const result = discoverRules(repo);

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
    const result = discoverRules(fixtureRepo(files));

    expect(result.sources).toHaveLength(80);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-this-is-a-secret-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("reads only discovered rule sources through validated tools", async () => {
    const repo = fixtureRepo({
      "AGENTS.md": "# Rules\nTOKEN=secret\n",
      "README.md": "# Not a rule source\n"
    });
    const registry = new ToolRegistry();
    registry.registerMany(rulesTools);

    const inventory = await registry
      .get("rules_inventory")!
      .execute({ workspace_path: repo }, { surface: "cli" });
    expect(inventory.text).toContain("AGENTS.md");

    const source = await registry
      .get("rules_read_source")!
      .execute({ workspace_path: repo, source_path: "AGENTS.md" }, { surface: "cli" });
    expect(source.text).toContain("TOKEN=[REDACTED]");

    expect(() =>
      registry
        .get("rules_read_source")!
        .execute({ workspace_path: repo, source_path: "README.md" }, { surface: "cli" })
    ).toThrow("rules_source_not_discovered");
    expect(() =>
      registry
        .get("rules_read_source")!
        .execute({ workspace_path: repo, source_path: "../AGENTS.md" }, { surface: "cli" })
    ).toThrow();
  });
});

function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-rules-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  return root;
}
