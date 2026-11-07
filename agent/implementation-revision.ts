import { Type, type Static } from 'typebox';

import { implementationResultSchema } from './implementation-result.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const source = Type.Object({ turnId: text, inputId: text }, { additionalProperties: false });
export type ImplementationSource = Static<typeof source>;
export const implementationRevisionProperties = {
  resultSource: Type.Optional(source),
  revisionSource: Type.Optional(source),
  resultHistory: Type.Optional(
    Type.Array(
      Type.Object(
        { source: Type.Optional(source), result: implementationResultSchema },
        {
          additionalProperties: false,
        },
      ),
    ),
  ),
};
