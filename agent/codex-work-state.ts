import { Type, type Static } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const codexWorkStateSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    cancelled: Type.Optional(Type.Literal(true)),
    selection: assessmentSelectionSchema,
    observation: Type.Optional(
      Type.Object(
        {
          turnId: text,
          afterItemId: text,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CodexWorkState = Static<typeof codexWorkStateSchema>;

export default function codexWorkState(record: { nativeWork?: CodexWorkState }) {
  return record.nativeWork;
}
