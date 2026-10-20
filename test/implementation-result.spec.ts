import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import {
  implementationResultSchema,
  implementationPresentation,
} from '../agent/implementation-result.ts';

describe('agent/implementation-result', () => {
  const report = {
    summary: 'Need a decision.',
    fullResult: 'Partial work and validation retained.',
  };
  it('should require meaningful bounded questions while preserving old results', () => {
    for (const outcome of ['done', 'blocked'])
      assert.equal(Value.Check(implementationResultSchema, { ...report, outcome }), true);
    const result = {
      ...report,
      outcome: 'clarification-needed' as const,
      questions: ['Which caller?'],
    };
    assert.equal(Value.Check(implementationResultSchema, result), true);
    for (const questions of [undefined, [], [' '], Array(11).fill('Question?')])
      assert.equal(Value.Check(implementationResultSchema, { ...result, questions }), false);
    const presentation = implementationPresentation(result);
    assert.ok(presentation.includes(result.questions[0]!));
    assert.ok(presentation.includes(report.fullResult));
  });
});
