import { Type } from 'typebox';

export const implementationResultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal('done'), Type.Literal('blocked')]),
    summary: Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' }),
    fullResult: Type.String({ minLength: 1, maxLength: 64000, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
