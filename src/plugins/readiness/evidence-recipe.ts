export interface ReadinessEvidenceRecipe {
  name: string;
  maxExcerptBytes: number;
  maxSearchResultsPerQuery: number;
  ignoredPathPatterns: string[];
  preferredExcerptPaths: string[];
  searchQueries: { name: string; query: string }[];
}

export const readinessEvidenceRecipe: ReadinessEvidenceRecipe = {
  name: "readiness-evidence",
  maxExcerptBytes: 3000,
  maxSearchResultsPerQuery: 20,
  ignoredPathPatterns: [
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".npmrc",
    "**/.npmrc",
    ".pypirc",
    "**/.pypirc",
    "*.pem",
    "**/*.pem",
    "*.key",
    "**/*.key",
    "*.p12",
    "**/*.p12",
    "*.pfx",
    "**/*.pfx",
    "id_rsa",
    "**/id_rsa",
    "id_ed25519",
    "**/id_ed25519",
    "*credentials*",
    "**/*credentials*",
    "*secret*",
    "**/*secret*"
  ],
  preferredExcerptPaths: [
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
  ],
  searchQueries: [
    { name: "validation", query: "make check" },
    { name: "safety", query: "approval" },
    { name: "logging", query: "logging" },
    { name: "database", query: "database" },
    { name: "dependency", query: "dependency" },
    { name: "standards", query: "standards" }
  ]
};
