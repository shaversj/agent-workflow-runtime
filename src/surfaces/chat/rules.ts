import { runRulesInventoryWorkflow, runRulesReadWorkflow } from "../../workflows/rules.js";
import type { ChatRequestContext, ChatResponse } from "./types.js";

type RulesRequest =
  | { kind: "inventory" }
  | { kind: "read"; sourcePath: string }
  | { kind: "clarify"; question: string };

export async function runRulesChatRequest(
  context: ChatRequestContext,
  enabledSources?: Iterable<string>
): Promise<ChatResponse | undefined> {
  if (enabledSources !== undefined && !new Set(enabledSources).has("rules")) return undefined;
  const request = parseRulesRequest(context);
  if (!request) return undefined;
  if (request.kind === "clarify") return { kind: "clarify", text: request.question };
  if (!context.repoTarget) return { kind: "clarify", text: "Which repository should I inspect?" };
  try {
    if (request.kind === "read") {
      const output = await runRulesReadWorkflow(context.repoTarget, request.sourcePath, {
        ref: context.ref,
        surface: "discord"
      });
      return {
        kind: "message",
        status: "completed",
        text: [
          `Rule source ${output.result.path}`,
          `Snapshot: ${output.workspace.ref} @ ${output.workspace.commitSha.slice(0, 12)} (committed snapshot)`,
          "",
          output.result.content,
          ...(output.result.truncated ? ["", "(Source truncated.)"] : [])
        ].join("\n")
      };
    }
    const output = await runRulesInventoryWorkflow(context.repoTarget, {
      ref: context.ref,
      surface: "discord"
    });
    const lines = [
      `Repository rules for ${output.workspace.displayOrigin}`,
      `Snapshot: ${output.workspace.ref} @ ${output.workspace.commitSha.slice(0, 12)} (committed snapshot)`,
      `Sources: ${output.result.source_count}${output.result.truncated ? "+" : ""}`,
      ...output.result.sources.map((source) => `- ${source.path} [${source.kind}]`)
    ];
    if (output.result.coverage.length > 0) {
      lines.push(
        "",
        "Standards coverage:",
        ...output.result.coverage.map(
          (item) => `- ${item.capability}: ${item.status}${item.expected ? " (declared)" : ""}`
        )
      );
    }
    return { kind: "message", status: "completed", text: lines.join("\n").slice(0, 1_800) };
  } catch (error) {
    return {
      kind: "message",
      status: "failed",
      text: error instanceof Error ? error.message : "rules_inspection_failed"
    };
  }
}

function parseRulesRequest(request: ChatRequestContext): RulesRequest | undefined {
  const text = request.sourceText.trim();
  const read = /\b(?:rules?|standards?)\s+read\s+([^\s]+)/i.exec(text);
  if (read?.[1]) {
    if (!request.repoTarget) {
      return { kind: "clarify", question: "Which repository should I inspect for rules?" };
    }
    return { kind: "read", sourcePath: read[1].replace(/[),.;]+$/, "") };
  }
  if (
    /\b(?:rules?|standards?)\s+(?:inventory|list)\b/i.test(text) ||
    /\b(?:what|which)\b.*\b(?:rules?|standards?)\b/i.test(text)
  ) {
    if (!request.repoTarget) {
      return { kind: "clarify", question: "Which repository should I inspect for rules?" };
    }
    return { kind: "inventory" };
  }
  return undefined;
}
