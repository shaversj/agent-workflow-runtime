import { Type } from "typebox";
import type { Static } from "typebox";

import { parseCoding } from "../plugins/coding/schemas.js";

export const CodingProfileSchema = Type.Object(
  {
    image: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$" }),
    requiredChecks: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
      minItems: 1,
      maxItems: 10
    }),
    ignore: Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_.-]+$" }), { maxItems: 20 }),
    principal: Type.String({ minLength: 1, maxLength: 128 }),
    changePolicy: Type.Optional(
      Type.Object(
        {
          protectedPaths: Type.Optional(
            Type.Array(
              Type.String({
                minLength: 1,
                maxLength: 512,
                pattern: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$)).+$"
              }),
              { maxItems: 100 }
            )
          ),
          allowDependencyChanges: Type.Optional(Type.Boolean()),
          maxChangedFiles: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          maxChangedBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 10 * 1024 * 1024 }))
        },
        { additionalProperties: false }
      )
    )
  },
  { additionalProperties: false }
);
export type CodingProfile = Static<typeof CodingProfileSchema>;
export function parseProfile(value: unknown): CodingProfile {
  return parseCoding(CodingProfileSchema, value);
}
