import type { RepositoryGuidanceSource } from "./schemas.js";

export function isRepositoryGuidanceApplicable(
  source: RepositoryGuidanceSource,
  repositoryRelativePath: string
): boolean {
  const target = normalizePath(repositoryRelativePath);
  if (!target) return false;

  switch (source.scope.kind) {
    case "repository":
      return true;
    case "subtree":
      return target === source.scope.root || target.startsWith(`${source.scope.root}/`);
    case "path-glob":
      return source.scope.patterns.some((pattern) => matchesGlob(target, pattern));
    case "unknown":
      return false;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function matchesGlob(file: string, pattern: string): boolean {
  const expression = pattern
    .replaceAll("\\", "/")
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
