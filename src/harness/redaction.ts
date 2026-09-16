export interface EvidenceRedactionStats {
  redacted_occurrences: number;
}

export function applicationCredentials(): string[] {
  // Load only credentials consumed by this app, after environment configuration is loaded.
  return [
    process.env.MINIMAX_API_KEY,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
    process.env.CODING_GITHUB_READ_TOKEN,
    process.env.CODING_GITHUB_WRITE_TOKEN,
    process.env.DISCORD_BOT_TOKEN
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
}

export function redactApplicationText(
  content: string,
  credentials = applicationCredentials()
): string {
  let safe = content;
  for (const credential of credentials) safe = safe.split(credential).join("[REDACTED]");
  return redactEvidenceText(safe);
}

const sensitiveName =
  /authorization|cookie|api[_-]?key|token|secret|password|pass|credential|private[_-]?key|database_url|db_url|^key$|signature/i;
const evidenceRedactionPatterns: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi,
    replacement: "$1[REDACTED_CREDENTIALS]@"
  },
  {
    pattern: /\b(?:Bearer|Basic)\s+[^\s"'<>\x60,;]+/gi,
    replacement: "[REDACTED_AUTH]"
  },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g,
    replacement: "[REDACTED_TOKEN]"
  }
];

export function redactEvidenceText(content: string, stats?: EvidenceRedactionStats): string {
  let redacted = content;
  for (const item of evidenceRedactionPatterns) {
    if (stats) stats.redacted_occurrences += countMatches(redacted, item.pattern);
    redacted = redacted.replace(item.pattern, item.replacement);
  }
  redacted = redacted.replace(
    /([?&])([\w.%-]+)=([^&#\s"'<>]*)/g,
    (match: string, prefix: string, key: string) => {
      let decoded = key;
      try {
        decoded = decodeURIComponent(key);
      } catch {
        /* Match the literal key if malformed. */
      }
      if (!sensitiveName.test(decoded)) return match;
      if (stats) ++stats.redacted_occurrences;
      return prefix + key + "=[REDACTED]";
    }
  );
  // Match a complete key once, then classify it; repeated wildcard/key searches backtrack
  // quadratically on large delimiter-free inputs.
  redacted = redacted.replace(
    /^([ \t]*(?:export[ \t]+)?)([\w]+)([ \t]*=[ \t]*)(.+)$/gm,
    (match: string, prefix: string, key: string, separator: string, value: string) => {
      if (!sensitiveName.test(key) || value === "[REDACTED]") return match;
      if (stats) ++stats.redacted_occurrences;
      return prefix + key + separator + "[REDACTED]";
    }
  );
  return redacted.replace(
    /(^|[\s{,;?&])(["']?)([\w.%-]+)\2([ \t]*[=:][ \t]*)(\[REDACTED(?:_[A-Z]+)?\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]"']+)/gm,
    (
      match: string,
      prefix: string,
      quote: string,
      key: string,
      separator: string,
      value: string
    ) => {
      let decoded = key;
      try {
        decoded = decodeURIComponent(key);
      } catch {
        /* Match the literal key if malformed. */
      }
      if (!sensitiveName.test(decoded) || /^\[REDACTED(?:_[A-Z]+)?\]$/.test(value)) return match;
      if (stats) ++stats.redacted_occurrences;
      const valueQuote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
      return prefix + quote + key + quote + separator + valueQuote + "[REDACTED]" + valueQuote;
    }
  );
}

function countMatches(content: string, pattern: RegExp): number {
  let count = 0;
  const matches = content.matchAll(pattern);
  while (!matches.next().done) ++count;
  return count;
}
