import { afterAll, beforeAll } from "vitest";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";

const original = new Agent();
const mock = new MockAgent();

beforeAll(() => {
  mock.enableNetConnect();
  mock
    .get("https://ossrules.md")
    .intercept({ path: "/api/v1/catalog", method: "GET" })
    .reply(200, {
      version: 1,
      scope: "Public test snapshot.",
      totals: { projects: 1, skills: 1, patterns: 1 },
      languages: [{ value: "TypeScript", count: 1 }],
      links: {
        projects: "https://ossrules.md/api/v1/projects",
        skills: "https://ossrules.md/api/v1/skills",
        patterns: "https://ossrules.md/api/v1/patterns"
      },
      queries: {
        projects: ["language", "pattern", "limit", "offset"],
        skills: ["repository", "limit", "offset"],
        defaults: { limit: 10, offset: 0 },
        maxLimit: 50,
        matching: "Test matching.",
        pagination: "Test pagination."
      }
    })
    .persist();
  mock
    .get("https://ossrules.md")
    .intercept({ path: "/api/v1/patterns", method: "GET" })
    .reply(200, {
      version: 1,
      total: 1,
      items: [
        {
          id: "hard-prohibition",
          name: "Hard prohibition",
          summary: "States a clear boundary.",
          projectCount: 1,
          apiUrl: "https://ossrules.md/api/v1/patterns/hard-prohibition",
          projectsUrl: "https://ossrules.md/api/v1/projects?pattern=hard-prohibition"
        }
      ]
    })
    .persist();
  setGlobalDispatcher(mock);
});

afterAll(async () => {
  setGlobalDispatcher(original);
  await mock.close();
  await original.close();
});
