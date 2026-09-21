import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mirrorStates = sqliteTable(
  "mirror_state",
  {
    identity: text("identity").primaryKey(),
    fenceCounter: integer("fence_counter").notNull().default(0),
    currentPath: text("current_path"),
    currentFence: integer("current_fence")
  },
  (t) => [
    check("ck_mirror_state_fence", sql`${t.fenceCounter} >= 0`),
    check(
      "ck_mirror_state_current",
      sql`(${t.currentPath} IS NULL AND ${t.currentFence} IS NULL) OR (${t.currentPath} IS NOT NULL AND ${t.currentFence} > 0)`
    )
  ]
);

export const mirrorLocks = sqliteTable(
  "mirror_lock",
  {
    identity: text("identity")
      .primaryKey()
      .references(() => mirrorStates.identity),
    fence: integer("fence").notNull(),
    ownerToken: text("owner_token").notNull(),
    ownerPid: integer("owner_pid").notNull(),
    ownerHost: text("owner_host").notNull(),
    stagingPath: text("staging_path").notNull(),
    acquiredAt: integer("acquired_at").notNull()
  },
  (t) => [
    check("ck_mirror_lock_fence", sql`${t.fence} > 0`),
    check("ck_mirror_lock_owner_pid", sql`${t.ownerPid} > 0`)
  ]
);

export const mirrorBootstrapSql = `
CREATE TABLE IF NOT EXISTS mirror_state (
  identity TEXT PRIMARY KEY,
  fence_counter INTEGER NOT NULL DEFAULT 0 CHECK(fence_counter >= 0),
  current_path TEXT,
  current_fence INTEGER,
  CONSTRAINT ck_mirror_state_current CHECK(
    (current_path IS NULL AND current_fence IS NULL) OR
    (current_path IS NOT NULL AND current_fence > 0)
  )
);
CREATE TABLE IF NOT EXISTS mirror_lock (
  identity TEXT PRIMARY KEY REFERENCES mirror_state(identity),
  fence INTEGER NOT NULL CHECK(fence > 0),
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  owner_host TEXT NOT NULL,
  staging_path TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);`;
