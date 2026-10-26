import { Type, type Static } from 'typebox';

import { implementationResultSchema, type ImplementationResult } from './implementation-result.ts';

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

/** owners verify authority before admitting an input; history never reopens completed work. */
export default function implementationRevision(
  work: {
    result?: ImplementationResult;
    resultSource?: ImplementationSource;
    resultHistory?: Array<{ source?: ImplementationSource }>;
  },
  input: ImplementationSource,
  authorized: boolean,
  completedTurnId = work.resultSource?.turnId,
) {
  if (
    !authorized ||
    !completedTurnId ||
    completedTurnId === input.turnId ||
    work.result?.outcome !== 'done' ||
    work.resultSource?.turnId === input.turnId ||
    work.resultHistory?.some(({ source }) => source?.turnId === input.turnId)
  )
    return false;
  return true;
}
