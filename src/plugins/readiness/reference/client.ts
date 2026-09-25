import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { request as undiciRequest } from "undici";

import { requestBoundedJson } from "../../../harness/http.js";
import { ossRulesCachePath } from "../../../workspaces/storage.js";
import { readOssRulesCache, writeOssRulesCache } from "./cache.js";
import {
  OssRulesCatalogSchema,
  OssRulesPatternDetailSchema,
  OssRulesPatternsSchema,
  OssRulesProjectDetailSchema,
  OssRulesProjectsSchema,
  OssRulesSkillDetailSchema,
  OssRulesSkillsSchema,
  type BenchmarkProvenance,
  type BenchmarkStatus,
  type OssRulesCatalog,
  type OssRulesPatternDetail,
  type OssRulesPatterns,
  type OssRulesProjectDetail,
  type OssRulesProjects,
  type OssRulesSkillDetail,
  type OssRulesSkills
} from "./schemas.js";

const BASE_URL = new URL("https://ossrules.md/api/v1");
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_DETAIL_READS = 4;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface BenchmarkResponse<T> {
  status: BenchmarkStatus;
  provenance: BenchmarkProvenance;
  data?: T;
  unavailable_reason?: string;
}

export interface OssRulesClientOptions {
  cacheRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  request?: typeof undiciRequest;
  now?: () => number;
}

export class OssRulesClient {
  private readonly cacheRoot: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  private readonly request?: typeof undiciRequest;
  private readonly now: () => number;
  private readonly pending = new Map<string, Promise<BenchmarkResponse<unknown>>>();
  private readonly languages = new Set<string>();
  private readonly patternIds = new Set<string>();
  private readonly repositories = new Set<string>();
  private readonly skills = new Set<string>();
  private readonly detailKeys = new Set<string>();

  constructor(options: OssRulesClientOptions = {}) {
    this.cacheRoot = options.cacheRoot ?? ossRulesCachePath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = options.signal;
    this.request = options.request;
    this.now = options.now ?? Date.now;
  }

  async catalog(): Promise<BenchmarkResponse<OssRulesCatalog>> {
    const result = await this.fetch("/catalog", OssRulesCatalogSchema);
    for (const language of result.data?.languages ?? []) this.languages.add(language.value);
    return result;
  }

  async listPatterns(): Promise<BenchmarkResponse<OssRulesPatterns>> {
    const result = await this.fetch("/patterns", OssRulesPatternsSchema);
    for (const pattern of result.data?.items ?? []) this.patternIds.add(pattern.id);
    return result;
  }

  async listProjects(
    options: {
      language?: string;
      pattern?: string;
      limit?: number;
    } = {}
  ): Promise<BenchmarkResponse<OssRulesProjects>> {
    if (options.language && !this.languages.has(options.language)) {
      throw new Error("ossrules_unknown_language");
    }
    if (options.pattern && !this.patternIds.has(options.pattern)) {
      throw new Error("ossrules_unknown_pattern");
    }
    const query = new URLSearchParams({ limit: String(validLimit(options.limit)) });
    if (options.language) query.set("language", options.language);
    if (options.pattern) query.set("pattern", options.pattern);
    const result = await this.fetch(`/projects?${query.toString()}`, OssRulesProjectsSchema);
    for (const project of result.data?.items ?? []) this.repositories.add(project.repository);
    return result;
  }

  async listSkills(options: {
    repository: string;
    limit?: number;
  }): Promise<BenchmarkResponse<OssRulesSkills>> {
    assertRepository(options.repository);
    if (!this.repositories.has(options.repository)) throw new Error("ossrules_unknown_repository");
    const query = new URLSearchParams({
      repository: options.repository,
      limit: String(validLimit(options.limit))
    });
    const result = await this.fetch(`/skills?${query.toString()}`, OssRulesSkillsSchema);
    for (const skill of result.data?.items ?? []) {
      this.skills.add(skillKey(skill.repository, skill.id));
    }
    return result;
  }

  async readPattern(id: string): Promise<BenchmarkResponse<OssRulesPatternDetail>> {
    assertIdentifier(id);
    if (!this.patternIds.has(id)) throw new Error("ossrules_unknown_pattern");
    return this.detail(
      `pattern:${id}`,
      `/patterns/${encodeURIComponent(id)}`,
      OssRulesPatternDetailSchema
    );
  }

  async readProject(repository: string): Promise<BenchmarkResponse<OssRulesProjectDetail>> {
    assertRepository(repository);
    if (!this.repositories.has(repository)) throw new Error("ossrules_unknown_repository");
    const [owner, name] = repository.split("/");
    return this.detail(
      `project:${repository}`,
      `/projects/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}?view=overview`,
      OssRulesProjectDetailSchema
    );
  }

  async readSkill(repository: string, id: string): Promise<BenchmarkResponse<OssRulesSkillDetail>> {
    assertRepository(repository);
    assertIdentifier(id);
    const key = skillKey(repository, id);
    if (!this.skills.has(key)) throw new Error("ossrules_unknown_skill");
    const [owner, name] = repository.split("/");
    return this.detail(
      `skill:${key}`,
      `/projects/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/skills/${encodeURIComponent(id)}`,
      OssRulesSkillDetailSchema
    );
  }

  private async detail<T>(
    key: string,
    endpoint: string,
    schema: TSchema
  ): Promise<BenchmarkResponse<T>> {
    if (!this.detailKeys.has(key) && this.detailKeys.size >= MAX_DETAIL_READS) {
      throw new Error("ossrules_detail_budget_exceeded");
    }
    this.detailKeys.add(key);
    return this.fetch(endpoint, schema) as Promise<BenchmarkResponse<T>>;
  }

  private fetch<TSchemaType extends TSchema>(
    endpoint: string,
    schema: TSchemaType
  ): Promise<BenchmarkResponse<Static<TSchemaType>>> {
    const existing = this.pending.get(endpoint);
    if (existing) return existing as Promise<BenchmarkResponse<Static<TSchemaType>>>;
    const request = this.fetchUncached(endpoint, schema);
    this.pending.set(endpoint, request);
    return request;
  }

  private async fetchUncached<TSchemaType extends TSchema>(
    endpoint: string,
    schema: TSchemaType
  ): Promise<BenchmarkResponse<Static<TSchemaType>>> {
    const cached = readOssRulesCache<Static<TSchemaType>>(endpoint, schema, this.cacheRoot);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "agent-workflow-runtime"
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    try {
      const response = await requestBoundedJson(this.endpointUrl(endpoint), {
        headers,
        timeoutMs: this.timeoutMs,
        signal: this.signal,
        request: this.request,
        limits: {
          encodedBytes: 512 * 1024,
          decodedBytes: 1024 * 1024,
          jsonNodes: 12_000,
          jsonDepth: 48,
          redirects: 1
        }
      });
      if (response.status === 304) {
        if (!cached) throw new Error("ossrules_cache_missing_for_304");
        const revalidatedAt = new Date(this.now()).toISOString();
        const etag = response.headers.get("etag") ?? cached.etag;
        writeOssRulesCache(
          {
            ...cached,
            fetched_at: revalidatedAt,
            ...(etag ? { etag } : {})
          },
          schema,
          this.cacheRoot
        );
        return {
          status: "revalidated",
          provenance: provenance(endpoint, revalidatedAt, etag),
          data: cached.payload
        };
      }
      if (!response.ok) throw new Error(`ossrules_http_${response.status}`);
      if (!Value.Check(schema, response.data)) throw new Error("ossrules_schema_invalid");
      const fetchedAt = new Date(this.now()).toISOString();
      const etag = response.headers.get("etag") ?? undefined;
      writeOssRulesCache(
        {
          version: 1,
          endpoint,
          api_version: 1,
          fetched_at: fetchedAt,
          ...(etag ? { etag } : {}),
          payload: response.data
        },
        schema,
        this.cacheRoot
      );
      return {
        status: "live",
        provenance: provenance(endpoint, fetchedAt, etag),
        data: response.data
      };
    } catch (error) {
      if (this.signal?.aborted) throw abortReason(this.signal);
      const now = this.now();
      const cacheAge = cached ? now - Date.parse(cached.fetched_at) : Number.POSITIVE_INFINITY;
      if (cached && Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge <= MAX_STALE_AGE_MS) {
        return {
          status: "stale",
          provenance: {
            ...provenance(endpoint, cached.fetched_at, cached.etag),
            cache_age_ms: cacheAge
          },
          data: cached.payload,
          unavailable_reason: safeReason(error)
        };
      }
      return {
        status: "unavailable",
        provenance: provenance(endpoint, new Date(now).toISOString()),
        unavailable_reason: safeReason(error)
      };
    }
  }

  private endpointUrl(endpoint: string): string {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) {
      throw new Error("ossrules_endpoint_invalid");
    }
    return new URL(`${BASE_URL.pathname}${endpoint}`, BASE_URL).href;
  }
}

function provenance(endpoint: string, fetchedAt: string, etag?: string): BenchmarkProvenance {
  return {
    api_version: 1,
    endpoint,
    fetched_at: fetchedAt,
    ...(etag ? { etag } : {})
  };
}

function validLimit(limit = 10): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("ossrules_limit_invalid");
  return limit;
}

function assertIdentifier(value: string): void {
  if (!identifierPattern.test(value)) throw new Error("ossrules_identifier_invalid");
}

function assertRepository(value: string): void {
  if (!repositoryPattern.test(value)) throw new Error("ossrules_repository_invalid");
}

function skillKey(repository: string, id: string): string {
  return `${repository}:${id}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("workflow_aborted");
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return "ossrules_request_failed";
  return /^(?:ossrules|http)_[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "ossrules_request_failed";
}
