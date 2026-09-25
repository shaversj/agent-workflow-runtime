import { Type, type Static } from "typebox";

const AccessLevelSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("read-only"),
  Type.Literal("read-write")
]);

const NetworkAccessSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("model-provider"),
  Type.Literal("open")
]);

export const ToolAuthoritySchema = Type.Object(
  {
    target: AccessLevelSchema,
    managedState: AccessLevelSchema,
    network: NetworkAccessSchema
  },
  { additionalProperties: false }
);

export const CredentialRequirementsSchema = Type.Array(Type.String({ minLength: 1 }), {
  uniqueItems: true
});

export type ToolAuthority = Static<typeof ToolAuthoritySchema>;
