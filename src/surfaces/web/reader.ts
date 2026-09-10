import fs from "node:fs";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Value } from "typebox/value";

import { listHistory, showHistory } from "../../db/history.js";
import { openHistoryReadConnection } from "../../db/index.js";
import { openRegisteredReport } from "../../db/inspection.js";
import { artifacts } from "../../db/schema.js";
import { ArtifactRecordSchema, parseHistory } from "../../harness/history-schemas.js";
import { agentOpsHome } from "../../workspaces/storage.js";
import { InspectorRequestSchema, validateInspectorResponse } from "./contracts.js";
import type { InspectorReport, InspectorResponse } from "./contracts.js";

function report(interactionId: string, artifactId: number, home: string): InspectorReport {
  const connection = openHistoryReadConnection({ home, busyTimeoutMs: 250 });
  if (!connection) return { available: false, reason: "History store does not exist." };
  try {
    const raw = drizzle(connection)
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.interactionId, interactionId)))
      .get();
    if (!raw) return { available: false, reason: "No report is registered to this interaction." };
    const artifact = parseHistory(ArtifactRecordSchema, raw);
    if (artifact.type !== "markdown" || artifact.availability !== "available")
      return { available: false, reason: "Registered report is unavailable." };
    try {
      const fd = openRegisteredReport(artifact.path, home);
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 262144));
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return {
          available: true,
          path: artifact.path,
          content: buffer.subarray(0, count).toString("utf8"),
          truncated: size > count
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return {
        available: false,
        reason:
          "Registered report is missing, unreadable, or outside the permitted artifact directory."
      };
    }
  } finally {
    connection.close();
  }
}

export function readInspector(input: unknown, home = agentOpsHome()): InspectorResponse {
  if (!Value.Check(InspectorRequestSchema, input))
    return { ok: false, error: "Invalid inspection request." };
  try {
    switch (input.method) {
      case "list":
        return validateInspectorResponse({
          ok: true,
          method: "list",
          data: listHistory({ ...input.options, home, busyTimeoutMs: 250, includePreview: true })
        });
      case "show":
        return validateInspectorResponse({
          ok: true,
          method: "show",
          data: showHistory(input.id, { ...input.options, home, busyTimeoutMs: 250 })
        });
      case "report":
        return validateInspectorResponse({
          ok: true,
          method: "report",
          data: report(input.interactionId, input.artifactId, home)
        });
    }
  } catch {
    return {
      ok: false,
      error:
        "History is unavailable or the query is invalid. Check the local store and filters, then retry."
    };
  }
}
