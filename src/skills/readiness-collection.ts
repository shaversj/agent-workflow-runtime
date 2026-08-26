export interface ReadinessCollectionSkill {
  name: string;
  maxExcerptBytes: number;
  maxSearchResultsPerQuery: number;
  ignoredPathPatterns: string[];
  expectedStandards: { category: string; paths: string[] }[];
  preferredExcerptPaths: string[];
  searchQueries: { name: string; query: string }[];
}

export const readinessCollectionSkill: ReadinessCollectionSkill = {
  name: "readiness-collection",
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
  expectedStandards: [
    { category: "testing", paths: ["docs/standards/testing.md", "standards/testing.md"] },
    { category: "database", paths: ["docs/standards/database.md", "standards/database.md"] },
    { category: "logging", paths: ["docs/standards/logging.md", "standards/logging.md"] },
    { category: "formatting", paths: ["docs/standards/formatting.md", "standards/formatting.md"] },
    {
      category: "static-analysis",
      paths: ["docs/standards/static-analysis.md", "standards/static-analysis.md"]
    },
    {
      category: "dependency-management",
      paths: ["docs/standards/dependency-management.md", "standards/dependency-management.md"]
    },
    {
      category: "security-and-privacy",
      paths: ["docs/standards/security-and-privacy.md", "standards/security-and-privacy.md"]
    },
    {
      category: "agent-tool-interfaces",
      paths: ["docs/standards/agent-tool-interfaces.md", "standards/agent-tool-interfaces.md"]
    }
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
