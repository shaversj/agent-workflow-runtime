import { Type, type Static } from "typebox";

import { runRulesInventoryWorkflow, runRulesReadWorkflow } from "../../workflows/rules.js";
import { markOption, normalizeCliArgs, parseCli, takeOptionValue } from "./args.js";

const RulesCliArgsSchema = Type.Union([
  Type.Object(
    {
      command: Type.Literal("inventory"),
      repoTarget: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1 }))
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      command: Type.Literal("read"),
      repoTarget: Type.String({ minLength: 1 }),
      sourcePath: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1 }))
    },
    { additionalProperties: false }
  )
]);

type RulesCliArgs = Static<typeof RulesCliArgsSchema>;

export function parseRulesCliArgs(args: string[]): RulesCliArgs {
  const normalized = normalizeCliArgs(args);
  const command = normalized[0];
  const positionals: string[] = [];
  const seen = new Set<string>();
  let ref: string | undefined;
  for (let index = 1; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === "--ref") {
      markOption(seen, arg);
      ref = takeOptionValue(normalized, index, arg);
      index += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown rules argument: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }
  if (command === "inventory" && positionals.length === 1) {
    return parseCli(RulesCliArgsSchema, { command, repoTarget: positionals[0], ref });
  }
  if (command === "read" && positionals.length === 2) {
    return parseCli(RulesCliArgsSchema, {
      command,
      repoTarget: positionals[0],
      sourcePath: positionals[1],
      ref
    });
  }
  throw new Error("Usage: agent-ops rules inventory <repo-target> [--ref ref] | rules read <repo-target> <source-path> [--ref ref]");
}

export async function runRulesCli(args: string[]): Promise<void> {
  const parsed = parseRulesCliArgs(args);
  if (parsed.command === "inventory") {
    const output = await runRulesInventoryWorkflow(parsed.repoTarget, { ref: parsed.ref });
    const lines = [
      `Repository rules for ${output.workspace.displayOrigin}`,
      `Snapshot: ${output.workspace.ref} @ ${output.workspace.commitSha.slice(0, 12)} (committed snapshot)`,
      `Sources: ${output.result.source_count}${output.result.truncated ? "+" : ""}`
    ];
    for (const source of output.result.sources) {
      lines.push(`- ${source.path} [${source.kind}, ${renderScope(source.scope)}]`);
    }
    if (output.result.coverage.length > 0) {
      lines.push("", "Standards coverage:");
      for (const item of output.result.coverage) {
        lines.push(
          `- ${item.capability}: ${item.status}${item.expected ? " (declared)" : ""}${item.paths.length ? ` [${item.paths.join(", ")}]` : ""}`
        );
      }
    }
    console.log(lines.join("\n"));
    return;
  }

  const output = await runRulesReadWorkflow(parsed.repoTarget, parsed.sourcePath, {
    ref: parsed.ref
  });
  console.log(
    [
      `Source: ${output.result.path}`,
      `Snapshot: ${output.workspace.ref} @ ${output.workspace.commitSha.slice(0, 12)} (committed snapshot)`,
      "",
      output.result.content,
      ...(output.result.truncated ? ["", "(Source truncated.)"] : [])
    ].join("\n")
  );
}

function renderScope(scope: { kind: string; root?: string; patterns?: string[] }): string {
  if (scope.kind === "subtree") return `subtree:${scope.root}`;
  if (scope.kind === "path-glob") return `path-glob:${scope.patterns?.join(",")}`;
  return scope.kind;
}
