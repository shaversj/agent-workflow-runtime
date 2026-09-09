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
export const DesktopListOptionsSchema = object(
  Type.Omit(HistoryListOptionsSchema, ["home", "busyTimeoutMs", "includePreview"]).properties
);
const DesktopShowOptionsSchema = object(
  Type.Omit(HistoryShowOptionsSchema, ["home", "busyTimeoutMs"]).properties
);
export const DesktopRequestSchema = Type.Union([
  object({ method: Type.Literal("list"), options: DesktopListOptionsSchema }),
  object({
    method: Type.Literal("show"),
    id: HistoryInteractionIdSchema,
    options: DesktopShowOptionsSchema
  }),
  object({
    method: Type.Literal("report"),
    interactionId: HistoryInteractionIdSchema,
    artifactId: Type.Integer({ minimum: 1 })
  })
]);
export const DesktopReportSchema = Type.Union([
  object({ available: Type.Literal(false), reason: Type.String({ maxLength: 500 }) }),
  object({
    available: Type.Literal(true),
    path: Type.String({ maxLength: 2048 }),
    content: Type.String({ maxLength: 262144 }),
    truncated: Type.Boolean()
  })
]);
export const DesktopResponseSchema = Type.Union([
  object({ ok: Type.Literal(false), error: Type.String({ maxLength: 500 }) }),
  object({ ok: Type.Literal(true), method: Type.Literal("list"), data: HistoryListResultSchema }),
  object({ ok: Type.Literal(true), method: Type.Literal("show"), data: HistoryDetailResultSchema }),
  object({ ok: Type.Literal(true), method: Type.Literal("report"), data: DesktopReportSchema })
]);
export type DesktopRequest = Static<typeof DesktopRequestSchema>;
export type DesktopResponse = Static<typeof DesktopResponseSchema>;
export type DesktopListOptions = Static<typeof DesktopListOptionsSchema>;
export type DesktopReport = Static<typeof DesktopReportSchema>;
export interface DesktopAPI {
  read(request: DesktopRequest): Promise<DesktopResponse>;
}
export function validateDesktopResponse(value: unknown): DesktopResponse {
  if (!Value.Check(DesktopResponseSchema, value)) throw new Error("Invalid desktop response");
  return value;
}
