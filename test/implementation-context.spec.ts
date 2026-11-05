import assert from 'node:assert/strict';

import implementationContext from '../agent/implementation-context.ts';
import type { AssessmentResult } from '../agent/assessment-result.ts';

const assessment = (plan: string) => ({ outcome: 'plan-ready', plan }) as AssessmentResult;

describe('agent/implementation-context', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should omit historical assessments and revisions from ${runtime} implementation context`, () => {
      const original = assessment('Original plan.');
      const reassessments = [
        { result: assessment('First revision.') },
        { result: assessment('Current plan.') },
      ];
      const before = structuredClone({ original, reassessments });
      const response = implementationContext({
        runtime,
        id: 'issue',
        path: '/checkout',
        assessment: original,
        reassessments,
      });
      assert.equal(response.plan, undefined);
      assert.equal(response.assessment, undefined);
      assert.deepEqual({ original, reassessments }, before);
    });

  it('should preserve an explicitly supplied plan over historical reassessment results', () => {
    const response = implementationContext({
      runtime: 'codex',
      id: 'issue',
      path: '/checkout',
      plan: 'Current explicit plan.',
      reassessments: [{ result: assessment('Historical revision.') }],
    });
    assert.equal(response.plan, 'Current explicit plan.');
  });
});
