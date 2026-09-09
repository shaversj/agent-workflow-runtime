import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

const text = Type.String({ maxLength: 2048 });
const id = Type.Integer({ minimum: 1 });
const optionalText = Type.Optional(text);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const TerminalStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted")
]);
export const ExecutionStatusSchema = Type.Union([Type.Literal("running"), TerminalStatusSchema]);
export type ExecutionStatus = Static<typeof ExecutionStatusSchema>;
export type TerminalStatus = Static<typeof TerminalStatusSchema>;
export const CaptureEnvelopeSchema = object({
  text: Type.String({ maxLength: 65536 }),
  redacted: Type.Boolean(),
  truncated: Type.Boolean(),
  omitted: Type.Boolean(),
  incomplete: Type.Boolean(),
  reasons: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
  capturedBytes: Type.Integer({ minimum: 0, maximum: 65536 })
});
export type CaptureEnvelope = Static<typeof CaptureEnvelopeSchema>;
export const HistoryOwnerSchema = object({
  token: Type.String({ minLength: 1, maxLength: 2048 }),
  pid: id,
  host: text
});
export type HistoryOwner = Static<typeof HistoryOwnerSchema>;
export const AcceptInteractionSchema = object({
  source: Type.Union([Type.Literal("cli"), Type.Literal("discord")]),
  kind: text,
  userMessage: Type.Unknown(),
  applicationId: optionalText,
  sourceMessageId: optionalText,
  conversationKey: optionalText,
  target: optionalText,
  metadata: Type.Optional(Type.Unknown())
});
export type AcceptInteractionInput = Static<typeof AcceptInteractionSchema>;
export const CreateRunSchema = object({
  interactionId: text,
  parentRunId: id,
  triggeringToolCallId: Type.Optional(id),
  kind: text,
  target: optionalText,
  ref: optionalText,
  commitSha: optionalText,
  metadata: Type.Optional(Type.Unknown())
});
export type CreateRunInput = Static<typeof CreateRunSchema>;
export const UpdateRunSchema = object({
  id,
  target: optionalText,
  ref: optionalText,
  commitSha: optionalText,
  metadata: Type.Optional(Type.Unknown())
});
export type UpdateRunInput = Static<typeof UpdateRunSchema>;
export const StartToolCallSchema = object({
  runId: id,
  ordinal: id,
  name: text,
  kind: Type.Union([
    Type.Literal("dispatch"),
    Type.Literal("discovery"),
    Type.Literal("capability"),
    Type.Literal("workflow")
  ]),
  input: Type.Unknown(),
  parentCallId: Type.Optional(id),
  providerCallId: optionalText,
  source: optionalText
});
export type StartToolCallInput = Static<typeof StartToolCallSchema>;
export const FinishToolCallSchema = object({
  id,
  status: TerminalStatusSchema,
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Unknown())
});
export type FinishToolCallInput = Static<typeof FinishToolCallSchema>;
export const StartModelCallSchema = object({ runId: id, ordinal: id, provider: text, model: text });
export type StartModelCallInput = Static<typeof StartModelCallSchema>;
const ModelUsageSchema = object({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Optional(Type.Integer({ minimum: 0 }))
});
export const FinishModelCallSchema = object({
  id,
  status: TerminalStatusSchema,
  usage: Type.Optional(ModelUsageSchema),
  error: Type.Optional(Type.Unknown())
});
export type FinishModelCallInput = Static<typeof FinishModelCallSchema>;
export const AppendMessageSchema = object({
  interactionId: text,
  runId: Type.Optional(id),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  content: Type.Unknown()
});
export type AppendMessageInput = Static<typeof AppendMessageSchema>;
export const RegisterArtifactSchema = object({
  interactionId: text,
  runId: Type.Optional(id),
  path: text,
  type: text,
  title: optionalText
});
export type RegisterArtifactInput = Static<typeof RegisterArtifactSchema>;
export const StartDeliveryAttemptSchema = object({ messageId: id, part: id, attempt: id });
export type StartDeliveryAttemptInput = Static<typeof StartDeliveryAttemptSchema>;
export const FinishDeliveryAttemptSchema = object({
  id,
  status: Type.Union([
    Type.Literal("acknowledged"),
    Type.Literal("failed"),
    Type.Literal("uncertain")
  ]),
  surfaceMessageId: optionalText,
  error: Type.Optional(Type.Unknown())
});
export type FinishDeliveryAttemptInput = Static<typeof FinishDeliveryAttemptSchema>;
export const FinishRunSchema = object({
  id,
  status: TerminalStatusSchema,
  error: Type.Optional(Type.Unknown())
});
export type FinishRunInput = Static<typeof FinishRunSchema>;
export const FinishInteractionSchema = object({
  id: text,
  status: TerminalStatusSchema,
  error: Type.Optional(Type.Unknown()),
  incomplete: Type.Optional(Type.Boolean())
});
export type FinishInteractionInput = Static<typeof FinishInteractionSchema>;
export const AbortUnfinishedSchema = object({
  interactionId: text,
  error: Type.Optional(Type.Unknown())
});
export type AbortUnfinishedInput = Static<typeof AbortUnfinishedSchema>;

const lifecycle = {
  status: ExecutionStatusSchema,
  startedAt: text,
  finishedAt: nullable(text),
  error: nullable(CaptureEnvelopeSchema)
};
export const InteractionRecordSchema = object({
  id: text,
  source: text,
  applicationId: nullable(text),
  sourceMessageId: nullable(text),
  conversationKey: nullable(text),
  target: nullable(text),
  ownerToken: text,
  ownerPid: id,
  ownerHost: text,
  incomplete: Type.Boolean(),
  metadata: CaptureEnvelopeSchema,
  ...lifecycle
});
export const RunRecordSchema = object({
  id,
  interactionId: text,
  parentRunId: nullable(id),
  triggeringToolCallId: nullable(id),
  kind: text,
  target: nullable(text),
  ref: nullable(text),
  commitSha: nullable(text),
  metadata: CaptureEnvelopeSchema,
  ...lifecycle
});
export const MessageRecordSchema = object({
  id,
  interactionId: text,
  runId: nullable(id),
  sequence: id,
  role: AppendMessageSchema.properties.role,
  content: CaptureEnvelopeSchema,
  createdAt: text
});
export const ToolCallRecordSchema = object({
  id,
  runId: id,
  parentCallId: nullable(id),
  ordinal: id,
  providerCallId: nullable(text),
  source: nullable(text),
  name: text,
  kind: StartToolCallSchema.properties.kind,
  input: CaptureEnvelopeSchema,
  result: nullable(CaptureEnvelopeSchema),
  ...lifecycle
});
export const ModelCallRecordSchema = object({
  id,
  runId: id,
  ordinal: id,
  provider: text,
  model: text,
  usageState: Type.Union([Type.Literal("known"), Type.Literal("unknown")]),
  inputTokens: nullable(Type.Integer({ minimum: 0 })),
  outputTokens: nullable(Type.Integer({ minimum: 0 })),
  totalTokens: nullable(Type.Integer({ minimum: 0 })),
  ...lifecycle
});
export const ArtifactRecordSchema = object({
  id,
  interactionId: text,
  runId: nullable(id),
  path: text,
  type: text,
  title: nullable(text),
  availability: Type.Union([Type.Literal("available"), Type.Literal("missing")]),
  createdAt: text
});
export const DeliveryAttemptRecordSchema = object({
  id,
  messageId: id,
  part: id,
  attempt: id,
  status: Type.Union([Type.Literal("pending"), FinishDeliveryAttemptSchema.properties.status]),
  surfaceMessageId: nullable(text),
  error: nullable(CaptureEnvelopeSchema),
  startedAt: text,
  finishedAt: nullable(text)
});

export function parseHistory<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error("Invalid history contract");
  if (Object.is(schema, CaptureEnvelopeSchema)) {
    const envelope = value as CaptureEnvelope;
    if (
      envelope.capturedBytes !== Buffer.byteLength(envelope.text) ||
      Buffer.byteLength(JSON.stringify(envelope)) > 65536
    )
      throw new Error("Invalid history capture size");
  }
  return value;
}

// Local inspection contracts are separate from recorder inputs and chat tool projections.
export const HistoryInteractionIdSchema = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
});
export const HistoryTimestampSchema = Type.String({
  maxLength: 40,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$"
});
const historySource = Type.Union([Type.Literal("cli"), Type.Literal("discord")]);
const historyPageOptions = {
  home: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  busyTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: "^[A-Za-z0-9_-]+$" }))
};
export const HistoryListOptionsSchema = object({
  ...historyPageOptions,
  target: optionalText,
  source: Type.Optional(historySource),
  outcome: Type.Optional(ExecutionStatusSchema),
  since: Type.Optional(HistoryTimestampSchema),
  until: Type.Optional(HistoryTimestampSchema)
});
export const HistoryShowOptionsSchema = object(historyPageOptions);
export const HistoryCursorSchema = object({
  version: Type.Literal(1),
  context: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  at: HistoryTimestampSchema,
  key: Type.String({ minLength: 1, maxLength: 100 })
});
const HistoryOwnershipSchema = Type.Union([
  Type.Literal("live"),
  Type.Literal("absent"),
  Type.Literal("foreign"),
  Type.Literal("uncertain"),
  Type.Literal("not-applicable")
]);
const count = Type.Integer({ minimum: 0 });
export const HistoryUsageSchema = object({
  knownCalls: count,
  unknownCalls: count,
  inputTokens: count,
  outputTokens: count,
  totalTokens: count
});
export const HistoryDeliverySchema = object({
  pending: count,
  acknowledged: count,
  failed: count,
  uncertain: count
});
export const HistorySummaryRowSchema = object({
  id: HistoryInteractionIdSchema,
  source: historySource,
  target: nullable(text),
  status: ExecutionStatusSchema,
  startedAt: HistoryTimestampSchema,
  finishedAt: nullable(HistoryTimestampSchema),
  incomplete: Type.Boolean(),
  ownerPid: id,
  ownerHost: text
});
const historyAnnotations = {
  ownership: HistoryOwnershipSchema,
  usage: HistoryUsageSchema,
  delivery: HistoryDeliverySchema
};
const HistorySummarySchema = object({
  ...Type.Omit(HistorySummaryRowSchema, ["ownerPid", "ownerHost"]).properties,
  ...historyAnnotations
});
const HistoryActivityKindSchema = Type.Union([
  Type.Literal("message"),
  Type.Literal("run"),
  Type.Literal("tool"),
  Type.Literal("model"),
  Type.Literal("artifact"),
  Type.Literal("delivery")
]);
export const HistoryActivityRefSchema = object({
  kind: HistoryActivityKindSchema,
  id,
  at: HistoryTimestampSchema,
  key: Type.String({ pattern: "^(message|run|tool|model|artifact|delivery):[1-9][0-9]*$" })
});
const activityItem = <K extends string, T extends TSchema>(kind: K, record: T) =>
  object({
    kind: Type.Literal(kind),
    at: HistoryTimestampSchema,
    key: HistoryActivityRefSchema.properties.key,
    record
  });
export const HistoryActivityItemSchema = Type.Union([
  activityItem("message", MessageRecordSchema),
  activityItem("run", RunRecordSchema),
  activityItem("tool", ToolCallRecordSchema),
  activityItem("model", ModelCallRecordSchema),
  activityItem("artifact", ArtifactRecordSchema),
  activityItem("delivery", DeliveryAttemptRecordSchema)
]);
const storeState = Type.Union([Type.Literal("absent"), Type.Literal("available")]);
const nextCursor = nullable(Type.String({ maxLength: 2048 }));
export const HistoryListResultSchema = object({
  store: storeState,
  interactions: Type.Array(HistorySummarySchema, { maxItems: 100 }),
  nextCursor
});
export const HistoryDetailResultSchema = Type.Union([
  object({ store: storeState, found: Type.Literal(false), reason: text }),
  object({
    store: Type.Literal("available"),
    found: Type.Literal(true),
    interaction: object({ ...InteractionRecordSchema.properties, ...historyAnnotations }),
    activity: object({
      items: Type.Array(HistoryActivityItemSchema, { maxItems: 100 }),
      nextCursor
    })
  })
]);
export type HistoryListResult = Static<typeof HistoryListResultSchema>;
export type HistoryDetailResult = Static<typeof HistoryDetailResultSchema>;
export type HistoryActivityItem = Static<typeof HistoryActivityItemSchema>;
