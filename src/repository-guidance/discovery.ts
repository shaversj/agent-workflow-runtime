import fs from "node:fs";
import path from "node:path";

import { redactEvidenceText, type EvidenceRedactionStats } from "../harness/redaction.js";
import { isRepositoryGuidanceApplicable } from "./applicability.js";
import {
  parseRepositoryGuidanceInventory,
  type RepositoryGuidanceCoverage,
  type RepositoryGuidanceInventory,
  type RepositoryGuidanceSource
} from "./schemas.js";

const MAX_SOURCES = 80;
const MAX_EXCERPT_BYTES = 4 * 1024;
const ignoredDirectories = new Set([
  ".agent-readiness",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules"
]);

interface Candidate {
  path: string;
  kind: RepositoryGuidanceSource["kind"];
}

export { isRepositoryGuidanceApplicable };

export function discoverRepositoryGuidance(repoPath: string): RepositoryGuidanceInventory {
  const root = realDirectory(repoPath);
  const candidates = discoverCandidates(root);
  const stats: EvidenceRedactionStats = { redacted_occurrences: 0 };
  const warnings: string[] = [];
  const selected = candidates.slice(0, MAX_SOURCES);
  const sources = selected.flatMap((candidate) => {
    const source = readGuidanceSource(root, candidate, stats, warnings);
    return source ? [source] : [];
  });
  return parseRepositoryGuidanceInventory({
    version: 1,
    source_count: candidates.length,
    sources,
    coverage: buildCoverage(sources),
    warnings,
    truncated: candidates.length > MAX_SOURCES,
    redacted_occurrences: stats.redacted_occurrences
  });
}

function discoverCandidates(root: string): Candidate[] {
  const files: Candidate[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const kind = sourceKind(relative);
      if (kind) files.push({ path: relative, kind });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sourceKind(relativePath: string): RepositoryGuidanceSource["kind"] | undefined {
  const lower = relativePath.toLowerCase();
  const base = path.posix.basename(lower);
  if (base === "agents.md") return "agents";
  if (base === "claude.md") return "claude";
  if (lower === ".cursorrules" || /^\.cursor\/rules\/.*\.(?:md|mdc)$/.test(lower)) {
    return "cursor";
  }
  if (lower === ".github/copilot-instructions.md") return "copilot";
  if (/^(?:docs\/)?standards\/.*\.md$/.test(lower)) return "standard";
  return undefined;
}

function readGuidanceSource(
  root: string,
  candidate: Candidate,
  stats: EvidenceRedactionStats,
  inventoryWarnings: string[]
): RepositoryGuidanceSource | undefined {
  const warnings: string[] = [];
  let raw: Buffer;
  try {
    raw = fs.readFileSync(safeSourcePath(root, candidate.path));
  } catch {
    inventoryWarnings.push(`unreadable:${candidate.path}`);
    return undefined;
  }
  if (raw.includes(0)) {
    inventoryWarnings.push(`binary:${candidate.path}`);
    return undefined;
  }
  const truncated = raw.byteLength > MAX_EXCERPT_BYTES;
  if (truncated) warnings.push("excerpt_truncated");
  const text = raw.subarray(0, MAX_EXCERPT_BYTES).toString("utf8");
  const excerpt = redactEvidenceText(text, stats);
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const scope = guidanceScope(candidate, text);
  return {
    kind: candidate.kind,
    path: candidate.path,
    ...(title ? { title } : {}),
    scope,
    languages: inferLanguages(candidate.path, scope),
    tools: inferTools(candidate.kind),
    excerpt,
    truncated,
    untrusted: true,
    warnings
  };
}

function guidanceScope(
  candidate: Candidate,
  content: string
): RepositoryGuidanceSource["scope"] {
  if (candidate.kind === "cursor") {
    const patterns = cursorGlobs(content);
    if (patterns.length > 0) return { kind: "path-glob", patterns };
  }
  if (candidate.kind === "agents" || candidate.kind === "claude") {
    const root = path.posix.dirname(candidate.path);
    return root === "." ? { kind: "repository" } : { kind: "subtree", root };
  }
  return { kind: "repository" };
}

function cursorGlobs(content: string): string[] {
  const match = /^globs:\s*(.+)$/m.exec(content)?.[1]?.trim();
  if (!match) return [];
  const values = match.startsWith("[") && match.endsWith("]") ? match.slice(1, -1) : match;
  return values
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .slice(0, 20);
}

function inferLanguages(
  relativePath: string,
  scope: RepositoryGuidanceSource["scope"]
): string[] {
  const corpus = [relativePath, ...(scope.kind === "path-glob" ? scope.patterns : [])].join(" ");
  const languages = new Set<string>();
  if (/typescript|javascript|\.tsx?\b|\.jsx?\b/i.test(corpus)) languages.add("typescript");
  if (/python|\.py\b/i.test(corpus)) languages.add("python");
  if (/rust|\.rs\b/i.test(corpus)) languages.add("rust");
  if (/golang|\/go\/|\.go\b/i.test(corpus)) languages.add("go");
  return [...languages];
}

function inferTools(kind: RepositoryGuidanceSource["kind"]): string[] {
  if (kind === "claude") return ["claude"];
  if (kind === "cursor") return ["cursor"];
  if (kind === "copilot") return ["copilot"];
  return [];
}

function buildCoverage(sources: RepositoryGuidanceSource[]): RepositoryGuidanceCoverage[] {
  const standards = sources.filter((source) => source.kind === "standard");
  const observed = new Map<string, string[]>();
  for (const source of standards) {
    const capability = standardCapability(source.path);
    if (!capability || capability === "readme" || capability === "index") continue;
    const paths = observed.get(capability) ?? [];
    paths.push(source.path);
    observed.set(capability, paths);
  }

  const expected = new Set<string>();
  for (const source of standards.filter((item) => /\/(?:readme|index)\.md$/i.test(item.path))) {
    const directory = path.posix.dirname(source.path);
    for (const match of source.excerpt.matchAll(/\]\(([^)#?]+\.md)(?:#[^)]+)?\)/gi)) {
      const linked = path.posix.normalize(path.posix.join(directory, match[1]!));
      const capability = standardCapability(linked);
      if (capability && capability !== "readme" && capability !== "index") expected.add(capability);
    }
  }

  return [...new Set([...observed.keys(), ...expected])]
    .sort()
    .map((capability) => ({
      capability,
      status: observed.has(capability) ? "observed" : "missing",
      expected: expected.has(capability),
      paths: observed.get(capability) ?? []
    }));
}

function standardCapability(relativePath: string): string | undefined {
  const base = path.posix.basename(relativePath).replace(/\.md$/i, "");
  const normalized = base
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  return normalized || undefined;
}

function realDirectory(input: string): string {
  const resolved = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("repository_guidance_workspace_not_directory");
  return resolved;
}

function safeSourcePath(root: string, relativePath: string): string {
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error("repository_guidance_source_invalid");
  }
  const real = fs.realpathSync(absolute);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error("repository_guidance_source_invalid");
  }
  return real;
}
