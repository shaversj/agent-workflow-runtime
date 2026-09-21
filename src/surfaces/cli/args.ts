import type { TSchema, Static } from "typebox";
import { Value } from "typebox/value";

export function normalizeCliArgs(args: string[]): string[] {
  const normalized = args[0] === "--" ? args.slice(1) : [...args];
  if (normalized.includes("--")) throw new Error("cli_separator_misplaced");
  return normalized;
}

export function parseCli<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error("cli_arguments_invalid");
  return value;
}

export function takeOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function markOption(seen: Set<string>, flag: string): void {
  if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
  seen.add(flag);
}
