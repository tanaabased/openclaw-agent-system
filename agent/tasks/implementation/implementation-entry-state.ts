import { Type, type Static } from 'typebox';

import { assessmentSelectionSchema } from '../assessment/assessment-selection.ts';
import { issueProgressionSchema } from '../issue-progression.ts';
import { issueDeliveryStateSchema } from '../delivery/issue-delivery-state.ts';

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
      selection: Type.Optional(assessmentSelectionSchema),
      progression: Type.Optional(issueProgressionSchema),
      scope: Type.Union([Type.Literal('local'), Type.Literal('pull-request')]),
      delivery: Type.Optional(issueDeliveryStateSchema),
      authorization: source,
      scopeSource: source,
      caller: source,
    },
    { additionalProperties: false },
  ),
);
export type ImplementationEntry = Static<typeof implementationEntriesSchema>[number];
