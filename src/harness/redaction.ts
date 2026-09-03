export interface EvidenceRedactionStats {
  redacted_occurrences: number;
}

const evidenceRedactionPatterns: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    pattern:
      /^(\s*(?:export\s+)?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE[_-]?KEY|DATABASE_URL|DB_URL)[A-Z0-9_]*\s*=\s*)(.+)$/gim,
    replacement: "$1[REDACTED]"
  },
  {
    pattern:
      /(["']?[\w.-]*(?:api[_-]?key|token|secret|password|credential|private[_-]?key)[\w.-]*["']?\s*:\s*["'])([^"',}]+)(["'])/gi,
    replacement: "$1[REDACTED]$3"
  },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi,
    replacement: "$1[REDACTED_CREDENTIALS]@"
  }
];

export function redactEvidenceText(content: string, stats?: EvidenceRedactionStats): string {
  let redacted = content;
  for (const item of evidenceRedactionPatterns) {
    if (stats) stats.redacted_occurrences += countMatches(redacted, item.pattern);
    redacted = redacted.replace(item.pattern, item.replacement);
  }
  return redacted;
}

function countMatches(content: string, pattern: RegExp): number {
  return Array.from(content.matchAll(pattern)).length;
}
