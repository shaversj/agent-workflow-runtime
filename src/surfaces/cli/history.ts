import { listHistory, showHistory } from "../../db/history.js";
import type {
  CaptureEnvelope,
  HistoryActivityItem,
  HistoryDetailResult,
  HistoryListResult
} from "../../harness/history-schemas.js";
import { markOption, normalizeCliArgs, takeOptionValue } from "./args.js";

export function runHistoryCli(args: string[]): void {
  const [command, ...rest] = normalizeCliArgs(args);
  if (command !== "list" && command !== "show")
    throw new Error("history requires a subcommand: list or show");
  const id = command === "show" ? rest.shift() : undefined;
  if (command === "show" && (!id || id.startsWith("--")))
    throw new Error("history show requires an interaction UUID");
  const options: Record<string, unknown> = {};
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--json") {
      markOption(seen, flag);
      json = true;
      continue;
    }
    const name = flag.slice(2);
    const allowed =
      command === "list"
        ? ["limit", "cursor", "target", "source", "outcome", "since", "until"]
        : ["limit", "cursor"];
    if (!flag.startsWith("--") || !allowed.includes(name))
      throw new Error(`Unknown history argument: ${flag}`);
    markOption(seen, flag);
    const value = takeOptionValue(rest, i, flag);
    i += 1;
    if (name === "limit" && !/^[1-9][0-9]*$/.test(value))
      throw new Error("--limit must be an integer between 1 and 100");
    options[name] = name === "limit" ? Number(value) : value;
  }
  if (command === "list") {
    const result = listHistory(options);
    console.log(json ? JSON.stringify(result, null, 2) : formatList(result));
    return;
  }
  const result = showHistory(id, options);
  console.log(json ? JSON.stringify(result, null, 2) : formatDetail(result));
  if (!result.found) process.exitCode = 1;
}

function usageText(usage: HistoryListResult["interactions"][number]["usage"]): string {
  const tokens = usage.knownCalls === 0 ? "unavailable" : `${usage.totalTokens} known`;
  return `${tokens} (${usage.knownCalls} measured calls, ${usage.unknownCalls} unknown calls)`;
}

function formatList(result: HistoryListResult): string {
  if (result.store === "absent") return "History store does not exist. No interactions recorded.";
  if (result.interactions.length === 0) return "No matching interactions.";
  const lines = result.interactions.map(
    (row) =>
      `${row.id} ${row.startedAt} source=${row.source} status=${row.status} owner=${row.ownership} target=${row.target ?? "none"} capture=${row.incomplete ? "incomplete" : "complete"} tokens=${usageText(row.usage)} delivery=${JSON.stringify(row.delivery)}`
  );
  if (result.nextCursor) lines.push(`Next cursor: ${result.nextCursor}`);
  return lines.join("\n");
}

function formatActivity(item: HistoryActivityItem): string {
  const row = item.record;
  const lines = [`${item.at} ${item.key}`];
  if ("status" in row) lines.push(`  Status: ${row.status}`);
  if (item.kind === "message") lines.push(`  ${item.record.role}: ${item.record.content.text}`);
  if (item.kind === "run")
    lines.push(
      `  Run: ${item.record.id} ${item.record.kind} parent=${item.record.parentRunId ?? "none"}`
    );
  if (item.kind === "tool") {
    lines.push(`  Tool: ${item.record.name} kind=${item.record.kind} run=${item.record.runId}`);
    lines.push(`  Input: ${item.record.input.text}`);
    if (item.record.result) lines.push(`  Result: ${item.record.result.text}`);
  }
  if (item.kind === "model")
    lines.push(
      `  Model: ${item.record.provider}/${item.record.model} run=${item.record.runId} tokens=${item.record.usageState === "known" ? item.record.totalTokens : "unavailable"}`
    );
  if (item.kind === "artifact")
    lines.push(`  Artifact: ${item.record.path} (${item.record.availability})`);
  if (item.kind === "delivery")
    lines.push(
      `  Delivery: message=${item.record.messageId} part=${item.record.part} attempt=${item.record.attempt}`
    );
  const captures: [string, CaptureEnvelope | null][] = [];
  if ("content" in row) captures.push(["content", row.content]);
  if ("metadata" in row) captures.push(["metadata", row.metadata]);
  if ("input" in row) captures.push(["input", row.input], ["result", row.result]);
  if ("error" in row) captures.push(["error", row.error]);
  for (const [key, capture] of captures) {
    if (!capture) continue;
    if (key === "error") lines.push(`  Error: ${capture.text}`);
    if (capture.incomplete)
      lines.push(
        `  ${key} capture: incomplete (redacted=${capture.redacted}, truncated=${capture.truncated}, omitted=${capture.omitted}; ${capture.reasons.join(", ")})`
      );
  }
  return lines.join("\n");
}

function formatDetail(result: HistoryDetailResult): string {
  if (!result.found) return result.reason;
  const row = result.interaction;
  const lines = [
    `Interaction: ${row.id}`,
    `Source: ${row.source}`,
    `Target: ${row.target ?? "none"}`,
    `Status: ${row.status} (owner: ${row.ownership})`,
    `Started: ${row.startedAt}`,
    `Finished: ${row.finishedAt ?? "unavailable"}`,
    `Capture: ${row.incomplete ? "incomplete" : "complete"}`,
    `Tokens: ${usageText(row.usage)}`,
    `Delivery: ${JSON.stringify(row.delivery)}`
  ];
  if (row.error) lines.push(`Error: ${row.error.text}`);
  lines.push("", ...result.activity.items.map(formatActivity));
  if (result.activity.nextCursor) lines.push(`Next cursor: ${result.activity.nextCursor}`);
  return lines.join("\n");
}
