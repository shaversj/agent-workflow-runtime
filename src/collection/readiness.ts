import fs from "node:fs";
import path from "node:path";

import {
  readinessCollectionSkill,
  type ReadinessCollectionSkill
} from "../skills/readiness-collection.js";

const ignoredDirs = new Set([
  ".agent-readiness",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "dist",
  "node_modules",
  "__pycache__"
]);

export interface ReadinessEvidenceFile {
  path: string;
  excerpt: string;
  truncated: boolean;
}

export interface ReadinessEvidenceSearchResult {
  path: string;
  line: number;
  text: string;
}

export interface ReadinessEvidence {
  collection_skill: string;
  standard_expectations: ReadinessCollectionSkill["expectedStandards"];
  key_files: string[];
  docs: string[];
  standards: string[];
  tests: string[];
  ci: string[];
  package_managers: string[];
  likely_entrypoints: string[];
  excerpts: ReadinessEvidenceFile[];
  searches: Record<string, ReadinessEvidenceSearchResult[]>;
}

export function collectReadinessEvidence(
  repoPath: string,
  skill: ReadinessCollectionSkill = readinessCollectionSkill
): ReadinessEvidence {
  const files = walkFiles(repoPath);
  const excerptPaths = selectExcerptPaths(files, skill);
  return {
    collection_skill: skill.name,
    standard_expectations: skill.expectedStandards,
    key_files: files.filter(isKeyFile).slice(0, 80),
    docs: files.filter(isDocFile).slice(0, 80),
    standards: files.filter(isStandardsFile).slice(0, 80),
    tests: files.filter(isTestFile).slice(0, 80),
    ci: files.filter(isCiFile).slice(0, 80),
    package_managers: files.filter(isPackageManagerFile),
    likely_entrypoints: files.filter(isLikelyEntrypoint).slice(0, 80),
    excerpts: excerptPaths.map((file) => readExcerpt(repoPath, file, skill.maxExcerptBytes)),
    searches: Object.fromEntries(
      skill.searchQueries.map((query) => [
        query.name,
        searchFiles(repoPath, files, query.query, skill.maxSearchResultsPerQuery)
      ])
    )
  };
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function selectExcerptPaths(files: string[], skill: ReadinessCollectionSkill): string[] {
  const selected = skill.preferredExcerptPaths.filter((file) => files.includes(file));
  if (selected.length >= 8) return selected.slice(0, 12);
  const markdownDocs = files.filter(isDocFile).slice(0, 12 - selected.length);
  return [...new Set([...selected, ...markdownDocs])].slice(0, 12);
}

function readExcerpt(repoPath: string, file: string, maxBytes: number): ReadinessEvidenceFile {
  const raw = fs.readFileSync(path.join(repoPath, file));
  const truncated = raw.byteLength > maxBytes;
  return {
    path: file,
    excerpt: raw.subarray(0, maxBytes).toString("utf8"),
    truncated
  };
}

function searchFiles(
  repoPath: string,
  files: string[],
  query: string,
  maxResults: number
): ReadinessEvidenceSearchResult[] {
  const normalizedQuery = query.toLowerCase();
  const matches: ReadinessEvidenceSearchResult[] = [];
  for (const file of files) {
    const content = safeReadText(path.join(repoPath, file));
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({ path: file, line: index + 1, text: line.trim().slice(0, 400) });
      if (matches.length >= maxResults) return matches;
    }
  }
  return matches;
}

function safeReadText(absolutePath: string): string | undefined {
  const raw = fs.readFileSync(absolutePath);
  if (raw.includes(0)) return undefined;
  return raw.toString("utf8");
}

function isKeyFile(file: string): boolean {
  return [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "Makefile",
    "package.json",
    "pyproject.toml",
    "pnpm-lock.yaml",
    "uv.lock",
    "tsconfig.json",
    "drizzle.config.ts"
  ].includes(file);
}

function isDocFile(file: string): boolean {
  return file.endsWith(".md") && (file.startsWith("docs/") || isKeyFile(file));
}

function isStandardsFile(file: string): boolean {
  return file.startsWith("docs/standards/") || file.startsWith("standards/");
}

function isTestFile(file: string): boolean {
  return (
    file.startsWith("tests/") ||
    file.includes("/tests/") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".spec.ts") ||
    file.endsWith("_test.py")
  );
}

function isCiFile(file: string): boolean {
  return file.startsWith(".github/workflows/") || file.startsWith(".gitlab-ci");
}

function isPackageManagerFile(file: string): boolean {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "pyproject.toml",
    "uv.lock",
    "requirements.txt"
  ].includes(file);
}

function isLikelyEntrypoint(file: string): boolean {
  return (
    file.startsWith("src/") &&
    (file.endsWith("/cli.ts") ||
      file.endsWith("/index.ts") ||
      file.endsWith("/main.ts") ||
      file.endsWith("/app.ts") ||
      file.endsWith("/cli.py") ||
      file.endsWith("/__main__.py"))
  );
}
