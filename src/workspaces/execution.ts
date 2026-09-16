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
    principal: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
);
export type CodingProfile = Static<typeof CodingProfileSchema>;
export function parseProfile(value: unknown): CodingProfile {
  return parseCoding(CodingProfileSchema, value);
}
