import { Type, type Static } from 'typebox';

import { assessmentResultSchema } from './assessment-result.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const assessmentEntrySchema = Type.Object(
  {
    id: hash,
    binding: hash,
    target: text,
    repositoryId: text,
    subjectId: text,
    checkout: Type.Object(
      { path: text, revision: text, dirty: Type.Boolean() },
      { additionalProperties: false },
    ),
    evidence: Type.String({ maxLength: 96000 }),
    selection: assessmentSelectionSchema,
    turnId: text,
    inputId: text,
    ownerDigest: Type.Optional(hash),
    result: Type.Optional(assessmentResultSchema),
    history: Type.Optional(Type.Array(assessmentResultSchema, { maxItems: 10 })),
    resultTurnId: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const assessmentEntriesSchema = Type.Array(assessmentEntrySchema, { maxItems: 20 });
export type AssessmentEntry = Static<typeof assessmentEntrySchema>;
export type AssessmentEntries = <T>(
  run: (entries: AssessmentEntry[], save: () => Promise<void>) => Promise<T>,
) => Promise<T>;
