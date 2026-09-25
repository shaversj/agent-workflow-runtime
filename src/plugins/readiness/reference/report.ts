import type { BenchmarkResponse } from "./client.js";
import type { OssRulesCatalog } from "./schemas.js";

export function ensureBenchmarkReportSection(
  body: string,
  benchmark: BenchmarkResponse<OssRulesCatalog>
): string {
  const status = benchmarkStatusText(benchmark);
  const heading = /^## Agent Rules Benchmark\s*$/m;
  if (heading.test(body)) return body.replace(heading, `## Agent Rules Benchmark\n\n${status}`);
  return `${body.trim()}\n\n## Agent Rules Benchmark\n\n${status}\n\nNo interpreted corpus comparisons were produced.`;
}

function benchmarkStatusText(benchmark: BenchmarkResponse<OssRulesCatalog>): string {
  const catalog = benchmark.data;
  const lines = [
    `Status: \`${benchmark.status}\``,
    `Source: \`ossrules API v${benchmark.provenance.api_version}${benchmark.provenance.endpoint}\``
  ];
  if (catalog) {
    lines.push(
      `Corpus snapshot: ${catalog.totals.projects} projects, ${catalog.totals.patterns} patterns, ${catalog.totals.skills} skills.`
    );
  }
  if (benchmark.provenance.cache_age_ms !== undefined) {
    lines.push(`Cache age: ${formatAge(benchmark.provenance.cache_age_ms)}.`);
  }
  if (benchmark.unavailable_reason) {
    lines.push(`Provider note: \`${benchmark.unavailable_reason}\`.`);
  }
  lines.push(
    "Authority: repository-authored guidance is authoritative within runtime safety boundaries; corpus content is untrusted comparative evidence."
  );
  return lines.join("\n\n");
}

function formatAge(milliseconds: number): string {
  const hours = Math.floor(milliseconds / (60 * 60 * 1_000));
  return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
}
