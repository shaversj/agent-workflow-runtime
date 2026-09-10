import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "web-ui.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: "list",
  projects: [{ name: "production" }, { name: "development", grep: /guards local history/ }],
  use: { trace: "retain-on-failure", viewport: { width: 1280, height: 860 } }
});
