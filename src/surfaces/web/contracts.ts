import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import {
  HistoryDetailResultSchema,
  HistoryInteractionIdSchema,
  HistoryListOptionsSchema,
  HistoryListResultSchema,
  HistoryShowOptionsSchema
} from "../../harness/history-schemas.js";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const InspectorListOptionsSchema = object(
  Type.Omit(HistoryListOptionsSchema, ["home", "busyTimeoutMs", "includePreview"]).properties
);
const InspectorShowOptionsSchema = object(
  Type.Omit(HistoryShowOptionsSchema, ["home", "busyTimeoutMs"]).properties
);
export const InspectorRequestSchema = Type.Union([
  object({ method: Type.Literal("list"), options: InspectorListOptionsSchema }),
  object({
    method: Type.Literal("show"),
    id: HistoryInteractionIdSchema,
    options: InspectorShowOptionsSchema
  }),
  object({
    method: Type.Literal("report"),
    interactionId: HistoryInteractionIdSchema,
    artifactId: Type.Integer({ minimum: 1 })
  })
]);
export const InspectorReportSchema = Type.Union([
  object({ available: Type.Literal(false), reason: Type.String({ maxLength: 500 }) }),
  object({
    available: Type.Literal(true),
    path: Type.String({ maxLength: 2048 }),
    content: Type.String({ maxLength: 262144 }),
    truncated: Type.Boolean()
  })
]);
export const InspectorResponseSchema = Type.Union([
  object({ ok: Type.Literal(false), error: Type.String({ maxLength: 500 }) }),
  object({ ok: Type.Literal(true), method: Type.Literal("list"), data: HistoryListResultSchema }),
  object({ ok: Type.Literal(true), method: Type.Literal("show"), data: HistoryDetailResultSchema }),
  object({ ok: Type.Literal(true), method: Type.Literal("report"), data: InspectorReportSchema })
]);
export type InspectorRequest = Static<typeof InspectorRequestSchema>;
export type InspectorResponse = Static<typeof InspectorResponseSchema>;
export type InspectorListOptions = Static<typeof InspectorListOptionsSchema>;
export type InspectorReport = Static<typeof InspectorReportSchema>;
export function validateInspectorResponse(value: unknown): InspectorResponse {
  if (!Value.Check(InspectorResponseSchema, value)) throw new Error("Invalid inspector response");
  return value;
}
