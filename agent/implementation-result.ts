import { Type, type Static } from 'typebox';
import { githubNotificationQuote } from '../channels/github/presentation/card.ts';
import discriminatedSchema from '../utils/discriminated-schema.ts';

const common = {
  summary: Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' }),
  fullResult: Type.String({ minLength: 1, maxLength: 64000, pattern: '\\S' }),
};
const implementationResultVariants = Type.Union([
  Type.Object(
    { ...common, outcome: Type.Union([Type.Literal('done'), Type.Literal('blocked')]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      outcome: Type.Literal('clarification-needed'),
      questions: Type.Array(Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }), {
        minItems: 1,
        maxItems: 10,
      }),
    },
    { additionalProperties: false },
  ),
]);
export const implementationResultSchema = discriminatedSchema(
  'outcome',
  implementationResultVariants,
);

export type ImplementationResult = Static<typeof implementationResultSchema>;

/** saved readback never enters implementation or schedules publication. */
export function implementationReadback(id: string, result?: ImplementationResult) {
  if (!result) throw new Error('implementation-result-missing');
  return {
    status: 'presented' as const,
    id,
    retained: true,
    previousResult: result,
    presentation: implementationPresentation(result),
    instruction:
      'Show the saved implementation result. This read grants no execution or publication authority; do not repeat implementation or schedule delivery.',
  };
}

export function implementationPresentation(result: Static<typeof implementationResultSchema>) {
  return result.outcome === 'clarification-needed'
    ? githubNotificationQuote(
        [
          '## ❓ Clarification needed',
          '',
          ...result.questions.map((question) => `- ${question}`),
          '',
          result.fullResult,
        ].join('\n'),
      )
    : result.fullResult;
}
