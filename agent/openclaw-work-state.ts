import { Type } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const input = Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false });
export const openclawWorkStateSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    selection: Type.Optional(assessmentSelectionSchema),
    implementation: Type.Optional(input),
    publication: Type.Optional(input),
    caller: Type.Optional(input),
  },
  { additionalProperties: false },
);
