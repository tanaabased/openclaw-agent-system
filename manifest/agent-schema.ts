import { Type, type Static } from 'typebox';

import type { AgentManifest } from './types.ts';
import { decodeResolvableString, externalResolvableStringSchema } from './value-schemas.ts';

export const externalAgentSectionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    name: Type.Optional(externalResolvableStringSchema),
    email: Type.Optional(externalResolvableStringSchema),
    description: Type.Optional(Type.String({ minLength: 1 })),
    avatar: Type.Optional(Type.String({ minLength: 1 })),
    emoji: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type ExternalAgentSection = Static<typeof externalAgentSectionSchema>;

/** Decode schema-owned agent keys without deep-converting literal manifest data. */
export function decodeAgentSection(value: ExternalAgentSection): AgentManifest['agent'] {
  return {
    id: value.id,
    ...(value.name === undefined ? {} : { name: decodeResolvableString(value.name) }),
    ...(value.email === undefined ? {} : { email: decodeResolvableString(value.email) }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
    ...(value.emoji === undefined ? {} : { emoji: value.emoji }),
  };
}
