import { Type, type Static } from 'typebox';

import { assessmentSelectionSchema } from './assessment-selection.ts';
import { implementationResultSchema } from './implementation-result.ts';
import { openclawWorkStateSchema } from './openclaw-work-state.ts';
import { issueProgressionSchema } from './issue-progression.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const source = Type.Object({ turnId: text, inputId: text }, { additionalProperties: false });
export const implementationEntriesSchema = Type.Array(
  Type.Object(
    {
      id: hash,
      target: text,
      repositoryId: text,
      subjectId: text,
      checkout: Type.Object(
        { path: text, revision: text, dirty: Type.Boolean() },
        { additionalProperties: false },
      ),
      plan: Type.Optional(Type.String({ minLength: 1, maxLength: 64000 })),
      evidence: Type.String({ maxLength: 96000 }),
      selection: Type.Optional(assessmentSelectionSchema),
      progression: Type.Optional(issueProgressionSchema),
      scope: Type.Union([Type.Literal('local'), Type.Literal('pull-request')]),
      delivery: openclawWorkStateSchema.properties.delivery,
      authorizationText: Type.Optional(Type.String({ maxLength: 100000 })),
      authorization: source,
      scopeSource: source,
      scopeText: Type.Optional(Type.String({ maxLength: 100000 })),
      caller: source,
      resultSource: Type.Optional(source),
      result: Type.Optional(implementationResultSchema),
    },
    { additionalProperties: false },
  ),
  { maxItems: 20 },
);
export type ImplementationEntry = Static<typeof implementationEntriesSchema>[number];
