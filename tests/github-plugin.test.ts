import { describe, expect, it, vi } from "vitest";

import { collectGitHubEvidence, collectGitHubIssues } from "../src/plugins/github/client.js";
import { resolveGitHubIdentity } from "../src/plugins/github/evidence.js";
import { createGitHubTools, githubTools } from "../src/plugins/github/tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createChatRequestContext } from "../src/surfaces/chat/request-context.js";

describe("github repository intelligence", () => {
  it("resolves safe GitHub identities from URL and SSH targets", () => {
    expect(resolveGitHubIdentity("https://token:secret@github.com/example/demo.git")).toEqual({
      host: "github.com",
      owner: "example",
      repo: "demo",
      full_name: "example/demo",
      display_url: "https://github.com/example/demo"
    });
    expect(resolveGitHubIdentity("git@github.com:example/demo.git")?.display_url).toBe(
      "https://github.com/example/demo"
    );
    expect(resolveGitHubIdentity("https://gitlab.com/example/demo")).toBeUndefined();
  });

  it("collects bounded GitHub evidence without exposing credentials", async () => {
    const requested: { url: string; authorization?: string }[] = [];
    const evidence = await collectGitHubEvidence(
      {
        ...githubIdentity()
      },
      {
        token: "secret-token",
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        fetch: (url, init) => {
          const requestUrl = fetchUrl(url);
          requested.push({
            url: requestUrl,
            authorization: new Headers(init?.headers).get("authorization") ?? undefined
          });
          return Promise.resolve(jsonResponse(responseBodyFor(requestUrl)));
        }
      }
    );

    expect(evidence).toMatchObject({
      available: true,
      identity: {
        full_name: "example/demo",
        display_url: "https://github.com/example/demo"
      },
      repository: {
        full_name: "example/demo",
        default_branch: "main"
      },
      workflow_runs: [{ name: "CI", conclusion: "success" }],
      pull_requests: [{ number: 7, title: "Improve reports" }],
      issues: [{ number: 9, title: "Add smoke test", labels: ["testing"] }],
      releases: [{ tag_name: "v0.1.0" }],
      collected_at: "2026-09-03T12:00:00.000Z"
    });
    expect(requested.every((request) => request.authorization === "Bearer secret-token")).toBe(
      true
    );
    expect(JSON.stringify(evidence)).not.toContain("secret-token");
  });

  it("redacts secret-shaped GitHub response text before returning evidence", async () => {
    const evidence = await collectGitHubEvidence(githubIdentity(), {
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      fetch: (url) => Promise.resolve(jsonResponse(secretBearingResponseFor(fetchUrl(url))))
    });
    const serialized = JSON.stringify(evidence);

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("repo-secret");
    expect(serialized).not.toContain("workflow-secret");
    expect(serialized).not.toContain("pr-secret");
    expect(serialized).not.toContain("issue-secret");
    expect(serialized).not.toContain("label-secret");
    expect(serialized).not.toContain("release-secret");
  });

  it("classifies repository unavailable responses without throwing", async () => {
    const cases: { status: number; reason: string; headers?: Record<string, string> }[] = [
      { status: 404, reason: "not_found" },
      { status: 401, reason: "unauthorized" },
      { status: 403, reason: "unauthorized" },
      { status: 403, reason: "rate_limited", headers: { "x-ratelimit-remaining": "0" } }
    ];

    for (const item of cases) {
      const evidence = await collectGitHubEvidence(githubIdentity(), {
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        fetch: () => Promise.resolve(jsonResponse({ message: "nope" }, item.status, item.headers))
      });
      expect(evidence).toMatchObject({
        available: false,
        reason: item.reason,
        identity: githubIdentity()
      });
    }
  });

  it("treats request failures, invalid JSON, and timeouts as unavailable evidence", async () => {
    await expect(
      collectGitHubEvidence(githubIdentity(), {
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        fetch: () => Promise.reject(new Error("network down"))
      })
    ).resolves.toMatchObject({ available: false, reason: "request_failed" });

    await expect(
      collectGitHubEvidence(githubIdentity(), {
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        fetch: () => Promise.resolve(new Response("{", { status: 200 }))
      })
    ).resolves.toMatchObject({ available: false, reason: "request_failed" });

    await expect(
      collectGitHubEvidence(githubIdentity(), {
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        timeoutMs: 1,
        fetch: () => new Promise<Response>(() => undefined)
      })
    ).resolves.toMatchObject({ available: false, reason: "request_failed" });
  });

  it("keeps repository evidence available when secondary GitHub endpoints fail", async () => {
    const evidence = await collectGitHubEvidence(githubIdentity(), {
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      fetch: (url) => {
        const requestUrl = fetchUrl(url);
        if (requestUrl.endsWith("/repos/example/demo")) {
          return Promise.resolve(jsonResponse(responseBodyFor(requestUrl)));
        }
        return Promise.resolve(jsonResponse({ message: "nope" }, 500));
      }
    });

    expect(evidence).toMatchObject({
      available: true,
      workflow_runs: [],
      pull_requests: [],
      issues: [],
      releases: [],
      warnings: [
        "workflow_runs_unavailable:500",
        "pull_requests_unavailable:500",
        "issues_unavailable:500",
        "releases_unavailable:500"
      ]
    });
  });

  it("over-fetches issues before filtering pull requests out of the sample", async () => {
    const requested: string[] = [];
    const result = await collectGitHubIssues(githubIdentity(), {
      limits: { issues: 2 },
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      fetch: (url) => {
        const requestUrl = fetchUrl(url);
        requested.push(requestUrl);
        if (requestUrl.includes("/issues?")) {
          return Promise.resolve(
            jsonResponse([
              { number: 1, title: "PR one", state: "open", pull_request: {}, labels: [] },
              { number: 2, title: "PR two", state: "open", pull_request: {}, labels: [] },
              { number: 11, title: "Issue one", state: "open", labels: [] },
              { number: 12, title: "Issue two", state: "open", labels: [] },
              { number: 13, title: "Issue three", state: "open", labels: [] }
            ])
          );
        }
        return Promise.resolve(jsonResponse(responseBodyFor(requestUrl)));
      }
    });

    expect(requested).toContain(
      "https://api.github.com/repos/example/demo/issues?state=open&per_page=8"
    );
    expect(result).toMatchObject({
      available: true,
      issues: [
        { number: 11, title: "Issue one" },
        { number: 12, title: "Issue two" }
      ]
    });
  });

  it("exposes read-only GitHub tools through the plugin registry", () => {
    const registry = new ToolRegistry();
    registry.registerMany(githubTools);
    expect(registry.get("github_get_repository_context")).toBeDefined();
    expect(githubTools.slice(0, 5).every((tool) => tool.readOnly === true)).toBe(true);
    expect(githubTools.slice(0, 5).every((tool) => tool.requiresApproval === false)).toBe(true);
    expect(githubTools.every((tool) => tool.allowedSurfaces?.includes("discord"))).toBe(true);
  });

  it("keeps publication and reconciliation hidden behind separate write authority", () => {
    const registry = new ToolRegistry();
    registry.registerMany(githubTools);

    expect(registry.get("github_publish_proposal")).toMatchObject({
      exposure: "hidden",
      readOnly: false,
      requiresApproval: true,
      requiredCredentials: ["github-publication-write"]
    });
    expect(registry.get("github_reconcile_publication")).toMatchObject({
      exposure: "hidden",
      readOnly: false,
      requiresApproval: true,
      requiredCredentials: ["github-publication-write"]
    });
    expect(registry.list({ surface: "discord" }).map((tool) => tool.name)).not.toContain(
      "publish_proposal"
    );
    expect(
      registry.list({ surface: "discord", includeHidden: true }).map((tool) => tool.name)
    ).not.toContain("publish_proposal");
    expect(
      registry
        .list({ surface: "discord", includeHidden: true, includeApprovalRequired: true })
        .map((tool) => tool.name)
    ).toEqual(expect.arrayContaining(["publish_proposal", "reconcile_publication"]));
  });

  it("does not spend ambient GitHub credentials on explicit Discord targets", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ambient-secret";
    const requested: { url: string; authorization?: string }[] = [];
    const registry = new ToolRegistry();
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = fetchUrl(url);
      requested.push({
        url: requestUrl,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      return Promise.resolve(jsonResponse(responseBodyFor(requestUrl)));
    });
    registry.registerMany(createGitHubTools({ fetch: globalThis.fetch }));

    try {
      const result = await registry.get("github_get_actions_status")!.execute(
        { repo_target: "https://github.com/example/demo" },
        {
          surface: "discord",
          requestContext: createChatRequestContext(
            "github actions repo=https://github.com/example/demo"
          )
        }
      );

      expect(result.result).toMatchObject({ available: true });
      expect(requested.every((request) => request.authorization === undefined)).toBe(true);
      expect(requested.map((request) => request.url)).toEqual([
        "https://api.github.com/repos/example/demo",
        "https://api.github.com/repos/example/demo/actions/runs?per_page=5"
      ]);
    } finally {
      vi.unstubAllGlobals();
      restoreEnv("GITHUB_TOKEN", originalToken);
    }
  });

  it("ignores a model-supplied repository that differs from authenticated Discord context", async () => {
    const requested: string[] = [];
    const registry = new ToolRegistry();
    vi.stubGlobal("fetch", (url: string | URL | Request) => {
      const requestUrl = fetchUrl(url);
      requested.push(requestUrl);
      return Promise.resolve(jsonResponse(responseBodyFor(requestUrl)));
    });
    registry.registerMany(createGitHubTools({ fetch: globalThis.fetch }));

    try {
      await registry.get("github_get_repository_context")!.execute(
        { repo_target: "https://github.com/attacker/override" },
        {
          surface: "discord",
          requestContext: createChatRequestContext(
            "github context repo=https://github.com/example/demo"
          )
        }
      );

      expect(requested).toEqual(["https://api.github.com/repos/example/demo"]);
      expect(requested.every((url) => !url.includes("attacker"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("can use ambient GitHub credentials for configured chat repository context", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ambient-secret";
    const requested: { authorization?: string }[] = [];
    const registry = new ToolRegistry();
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      requested.push({
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      return Promise.resolve(jsonResponse(responseBodyFor(fetchUrl(url))));
    });
    registry.registerMany(createGitHubTools({ fetch: globalThis.fetch }));

    try {
      await registry.get("github_get_repository_context")!.execute(
        {},
        {
          surface: "discord",
          requestContext: createChatRequestContext("github context", {
            defaultRepoPath: "https://github.com/example/demo"
          })
        }
      );

      expect(requested.every((request) => request.authorization === "Bearer ambient-secret")).toBe(
        true
      );
    } finally {
      vi.unstubAllGlobals();
      restoreEnv("GITHUB_TOKEN", originalToken);
    }
  });
});

function githubIdentity() {
  return {
    host: "github.com" as const,
    owner: "example",
    repo: "demo",
    full_name: "example/demo",
    display_url: "https://github.com/example/demo"
  };
}

function responseBodyFor(url: string): unknown {
  if (url.endsWith("/actions/runs?per_page=5")) {
    return {
      workflow_runs: [
        {
          name: "CI",
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/example/demo/actions/runs/1",
          updated_at: "2026-09-03T11:00:00Z"
        }
      ]
    };
  }
  if (url.endsWith("/pulls?state=open&per_page=5")) {
    return [
      {
        number: 7,
        title: "Improve reports",
        state: "open",
        draft: false,
        html_url: "https://github.com/example/demo/pull/7",
        updated_at: "2026-09-03T11:00:00Z"
      }
    ];
  }
  if (url.endsWith("/issues?state=open&per_page=20")) {
    return [
      {
        number: 9,
        title: "Add smoke test",
        state: "open",
        labels: [{ name: "testing" }],
        html_url: "https://github.com/example/demo/issues/9",
        updated_at: "2026-09-03T11:00:00Z"
      },
      {
        number: 7,
        title: "Improve reports",
        state: "open",
        pull_request: {},
        labels: []
      }
    ];
  }
  if (url.endsWith("/releases?per_page=3")) {
    return [
      {
        tag_name: "v0.1.0",
        name: "v0.1.0",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/example/demo/releases/tag/v0.1.0",
        published_at: "2026-09-03T10:00:00Z"
      }
    ];
  }
  return {
    full_name: "example/demo",
    html_url: "https://github.com/example/demo",
    description: "Demo repository",
    default_branch: "main",
    visibility: "public",
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    topics: ["agents"],
    stargazers_count: 12,
    open_issues_count: 3,
    pushed_at: "2026-09-03T11:00:00Z",
    updated_at: "2026-09-03T11:00:00Z"
  };
}

function secretBearingResponseFor(url: string): unknown {
  if (url.endsWith("/actions/runs?per_page=5")) {
    return {
      workflow_runs: [
        {
          name: '{"token":"workflow-secret"}',
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success"
        }
      ]
    };
  }
  if (url.endsWith("/pulls?state=open&per_page=5")) {
    return [{ number: 7, title: '{"apiKey":"pr-secret"}', state: "open", labels: [] }];
  }
  if (url.endsWith("/issues?state=open&per_page=20")) {
    return [
      {
        number: 9,
        title: '{"secret":"issue-secret"}',
        state: "open",
        labels: [{ name: '{"token":"label-secret"}' }]
      }
    ];
  }
  if (url.endsWith("/releases?per_page=3")) {
    return [{ tag_name: "v0.1.0", name: '{"password":"release-secret"}' }];
  }
  return {
    full_name: "example/demo",
    html_url: "https://github.com/example/demo",
    description: "API_KEY=repo-secret",
    default_branch: "main",
    visibility: "public",
    private: false,
    archived: false,
    fork: false,
    language: "TypeScript",
    topics: ["agents"],
    open_issues_count: 1
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
