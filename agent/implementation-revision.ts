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

export function sameImplementationInput(
  a: ImplementationSource | undefined,
  b: ImplementationSource,
) {
  return a?.turnId === b.turnId && a.inputId === b.inputId;
}

/** owners verify authority before admitting an input; history never reopens completed work. */
export function unprocessedImplementationInput(
  work: {
    result?: ImplementationResult;
    resultSource?: ImplementationSource;
    resultHistory?: Array<{ source?: ImplementationSource }>;
  },
  input: ImplementationSource,
  completedTurnId = work.resultSource?.turnId,
) {
  if (
    !completedTurnId ||
    ((!work.resultSource || work.resultSource.inputId === work.resultSource.turnId) &&
      completedTurnId === input.turnId) ||
    sameImplementationInput(work.resultSource, input) ||
    work.resultHistory?.some(({ source }) => sameImplementationInput(source, input))
  )
    return false;
  return true;
}

/** A new verified input may reopen a delivered implementation round, not retire its task. */
export default function implementationRevision(
  work: Parameters<typeof unprocessedImplementationInput>[0],
  input: ImplementationSource,
  authorized: boolean,
  completedTurnId = work.resultSource?.turnId,
) {
  return (
    authorized &&
    work.result?.outcome === 'done' &&
    unprocessedImplementationInput(work, input, completedTurnId)
  );
}
