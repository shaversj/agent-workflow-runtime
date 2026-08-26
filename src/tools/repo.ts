import fs from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import type { ToolContext, WorkflowTool } from "./types.js";

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

const ListFilesParams = Type.Object({
  pattern: Type.Optional(Type.String({ description: "Optional simple glob such as docs/*.md." })),
  max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 120 }))
});

const ReadFileParams = Type.Object({
  path: Type.String({ description: "Repo-relative file path to read." }),
  max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 50000, default: 12000 }))
});

const SearchFilesParams = Type.Object({
  query: Type.String({ description: "Case-insensitive text to search for." }),
  pattern: Type.Optional(Type.String({ description: "Optional simple glob filter." })),
  max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 80 }))
});

const RepoSummaryParams = Type.Object({
  max_excerpt_bytes: Type.Optional(Type.Number({ minimum: 500, maximum: 10000, default: 3000 }))
});

type ListFilesParamsType = Static<typeof ListFilesParams>;
type ReadFileParamsType = Static<typeof ReadFileParams>;
type SearchFilesParamsType = Static<typeof SearchFilesParams>;
type RepoSummaryParamsType = Static<typeof RepoSummaryParams>;

interface RepoSummaryFile {
  path: string;
  excerpt: string;
  truncated: boolean;
}

interface RepoSummary {
  key_files: string[];
  docs: string[];
  standards: string[];
  tests: string[];
  ci: string[];
  package_managers: string[];
  likely_entrypoints: string[];
  excerpts: RepoSummaryFile[];
}

export const repoSummaryTool: WorkflowTool<typeof RepoSummaryParams, RepoSummary> = {
  name: "repo_summary",
  label: "Repo summary",
  description:
    "Return a compact evidence packet for readiness interpretation: key files, docs, standards, tests, CI, package files, and excerpts from the most important text files.",
  parameters: RepoSummaryParams,
  execute(params: RepoSummaryParamsType, context: ToolContext) {
    const files = walkFiles(context.repoPath);
    const excerptLimit = params.max_excerpt_bytes ?? 3000;
    const excerptPaths = selectExcerptPaths(files);
    const result: RepoSummary = {
      key_files: files.filter(isKeyFile).slice(0, 80),
      docs: files.filter(isDocFile).slice(0, 80),
      standards: files.filter(isStandardsFile).slice(0, 80),
      tests: files.filter(isTestFile).slice(0, 80),
      ci: files.filter(isCiFile).slice(0, 80),
      package_managers: files.filter(isPackageManagerFile),
      likely_entrypoints: files.filter(isLikelyEntrypoint).slice(0, 80),
      excerpts: excerptPaths.map((file) => readExcerpt(context.repoPath, file, excerptLimit))
    };
    return {
      result,
      text: JSON.stringify(result, null, 2)
    };
  }
};

export const listFilesTool: WorkflowTool<
  typeof ListFilesParams,
  { files: string[]; truncated: boolean }
> = {
  name: "list_files",
  label: "List files",
  description:
    "List repo-relative files. Use this to discover likely documentation, standards, tests, and configuration.",
  parameters: ListFilesParams,
  execute(params: ListFilesParamsType, context: ToolContext) {
    const maxResults = params.max_results ?? 120;
    const files = walkFiles(context.repoPath)
      .filter((file) => (params.pattern ? matchesPattern(file, params.pattern) : true))
      .slice(0, maxResults + 1);
    const truncated = files.length > maxResults;
    const result = { files: files.slice(0, maxResults), truncated };
    return {
      result,
      text: JSON.stringify(result, null, 2)
    };
  }
};

export const readFileTool: WorkflowTool<
  typeof ReadFileParams,
  { path: string; content: string; truncated: boolean }
> = {
  name: "read_file",
  label: "Read file",
  description:
    "Read a UTF-8 text file from the target repository. The path must stay inside the repo.",
  parameters: ReadFileParams,
  execute(params: ReadFileParamsType, context: ToolContext) {
    const relativePath = normalizeRepoRelativePath(context.repoPath, params.path);
    const absolutePath = path.join(context.repoPath, relativePath);
    const maxBytes = params.max_bytes ?? 12000;
    const raw = fs.readFileSync(absolutePath);
    const truncated = raw.byteLength > maxBytes;
    const content = raw.subarray(0, maxBytes).toString("utf8");
    const result = { path: relativePath, content, truncated };
    return {
      result,
      text: JSON.stringify(result, null, 2)
    };
  }
};

export const searchFilesTool: WorkflowTool<
  typeof SearchFilesParams,
  { matches: { path: string; line: number; text: string }[]; truncated: boolean }
> = {
  name: "search_files",
  label: "Search files",
  description: "Search text files in the target repository for a case-insensitive query.",
  parameters: SearchFilesParams,
  execute(params: SearchFilesParamsType, context: ToolContext) {
    const maxResults = params.max_results ?? 80;
    const query = params.query.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];

    for (const file of walkFiles(context.repoPath)) {
      if (params.pattern && !matchesPattern(file, params.pattern)) continue;
      const absolutePath = path.join(context.repoPath, file);
      const content = safeReadText(absolutePath);
      if (content === undefined) continue;
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.toLowerCase().includes(query)) continue;
        matches.push({ path: file, line: index + 1, text: line.trim().slice(0, 400) });
        if (matches.length > maxResults) {
          const result = { matches: matches.slice(0, maxResults), truncated: true };
          return { result, text: JSON.stringify(result, null, 2) };
        }
      }
    }

    const result = { matches, truncated: false };
    return {
      result,
      text: JSON.stringify(result, null, 2)
    };
  }
};

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

function normalizeRepoRelativePath(repoPath: string, requestedPath: string): string {
  const absolutePath = path.resolve(repoPath, requestedPath);
  const relativePath = path.relative(repoPath, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the repository: ${requestedPath}`);
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`File does not exist: ${requestedPath}`);
  }
  return relativePath.split(path.sep).join("/");
}

function safeReadText(absolutePath: string): string | undefined {
  const raw = fs.readFileSync(absolutePath);
  if (raw.includes(0)) return undefined;
  return raw.toString("utf8");
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function selectExcerptPaths(files: string[]): string[] {
  const preferred = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "package.json",
    "pyproject.toml",
    "Makefile",
    ".github/workflows/ci.yml",
    "docs/standards/README.md",
    "docs/standards/testing.md",
    "docs/standards/database.md",
    "docs/standards/logging.md",
    "docs/standards/security-and-privacy.md",
    "docs/standards/dependency-management.md"
  ];
  const selected = preferred.filter((file) => files.includes(file));
  if (selected.length >= 8) return selected.slice(0, 12);
  const markdownDocs = files.filter(isDocFile).slice(0, 12 - selected.length);
  return [...new Set([...selected, ...markdownDocs])].slice(0, 12);
}

function readExcerpt(repoPath: string, file: string, maxBytes: number): RepoSummaryFile {
  const raw = fs.readFileSync(path.join(repoPath, file));
  const truncated = raw.byteLength > maxBytes;
  return {
    path: file,
    excerpt: raw.subarray(0, maxBytes).toString("utf8"),
    truncated
  };
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
