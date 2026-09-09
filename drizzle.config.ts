import { defineConfig } from "drizzle-kit";

import { historyDatabasePath } from "./src/workspaces/storage.js";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: historyDatabasePath() }
});
