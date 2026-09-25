import fs from "node:fs";
import path from "node:path";

import { redactEvidenceText, type EvidenceRedactionStats } from "../../harness/redaction.js";
import { readinessEvidenceRecipe, type ReadinessEvidenceRecipe } from "./evidence-recipe.js";
import { readinessPluginManifest } from "./manifest.js";
import { discoverRepositoryGuidance } from "../../repository-guidance/discovery.js";
import type { RepositoryGuidanceInventory } from "../../repository-guidance/schemas.js";

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

interface ReadinessEvidenceFile {
  path: string;
  excerpt: string;
  truncated: boolean;
}

interface ReadinessEvidenceSearchResult {
  path: string;
  line: number;
  text: string;
}

interface ReadinessEvidence {
  plugin: string;
  evidence_recipe: string;
  redaction: ReadinessEvidenceRedaction;
  guidance: RepositoryGuidanceInventory;
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

interface ReadinessEvidenceRedaction extends EvidenceRedactionStats {
  ignored_file_count: number;
  ignored_files: string[];
}

export function gatherReadinessEvidence(
  repoPath: string,
  recipe: ReadinessEvidenceRecipe = readinessEvidenceRecipe
): ReadinessEvidence {
  const allFiles = walkFiles(repoPath);
  const ignoredFiles = allFiles.filter((file) => shouldIgnoreEvidencePath(file, recipe));
  const files = allFiles.filter((file) => !shouldIgnoreEvidencePath(file, recipe));
  const redaction: ReadinessEvidenceRedaction = {
    ignored_file_count: ignoredFiles.length,
    ignored_files: ignoredFiles.slice(0, 80),
    redacted_occurrences: 0
  };
  const excerptPaths = selectExcerptPaths(files, recipe);
  return {
    plugin: readinessPluginManifest.name,
    evidence_recipe: recipe.name,
    redaction,
    guidance: discoverRepositoryGuidance(repoPath),
    key_files: files.filter(isKeyFile).slice(0, 80),
    docs: files.filter(isDocFile).slice(0, 80),
    standards: files.filter(isStandardsFile).slice(0, 80),
    tests: files.filter(isTestFile).slice(0, 80),
    ci: files.filter(isCiFile).slice(0, 80),
    package_managers: files.filter(isPackageManagerFile),
    likely_entrypoints: files.filter(isLikelyEntrypoint).slice(0, 80),
    excerpts: excerptPaths.map((file) =>
      readExcerpt(repoPath, file, recipe.maxExcerptBytes, redaction)
    ),
    searches: Object.fromEntries(
      recipe.searchQueries.map((query) => [
        query.name,
        searchFiles(repoPath, files, query.query, recipe.maxSearchResultsPerQuery, redaction)
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

function selectExcerptPaths(files: string[], recipe: ReadinessEvidenceRecipe): string[] {
  const selected = recipe.preferredExcerptPaths.filter((file) => files.includes(file));
  if (selected.length >= 8) return selected.slice(0, 12);
  const markdownDocs = files.filter(isDocFile).slice(0, 12 - selected.length);
  return [...new Set([...selected, ...markdownDocs])].slice(0, 12);
}

function readExcerpt(
  repoPath: string,
  file: string,
  maxBytes: number,
  redaction: ReadinessEvidenceRedaction
): ReadinessEvidenceFile {
  const raw = fs.readFileSync(path.join(repoPath, file));
  const truncated = raw.byteLength > maxBytes;
  return {
    path: file,
    excerpt: redactEvidenceText(raw.subarray(0, maxBytes).toString("utf8"), redaction),
    truncated
  };
}

function searchFiles(
  repoPath: string,
  files: string[],
  query: string,
  maxResults: number,
  redaction: ReadinessEvidenceRedaction
): ReadinessEvidenceSearchResult[] {
  const normalizedQuery = query.toLowerCase();
  const matches: ReadinessEvidenceSearchResult[] = [];
  for (const file of files) {
    const content = safeReadText(path.join(repoPath, file));
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        path: file,
        line: index + 1,
        text: redactEvidenceText(line, redaction).trim().slice(0, 400)
      });
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

function shouldIgnoreEvidencePath(file: string, recipe: ReadinessEvidenceRecipe): boolean {
  return recipe.ignoredPathPatterns.some((pattern) => matchesGlob(file, pattern));
}

function matchesGlob(file: string, pattern: string): boolean {
  const expression = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((value) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
        .join("[^/]*")
    )
    .join(".*");
  return new RegExp(`^${expression}$`).test(file);
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
