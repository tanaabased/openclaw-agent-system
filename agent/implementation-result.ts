import { Type, type Static } from 'typebox';
import { githubNotificationQuote } from '../channels/github/presentation/card.ts';

const common = {
  summary: Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' }),
  fullResult: Type.String({ minLength: 1, maxLength: 64000, pattern: '\\S' }),
};
export const implementationResultSchema = Type.Union([
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
