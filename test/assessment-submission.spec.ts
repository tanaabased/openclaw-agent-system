import assert from 'node:assert/strict';

import { Value } from 'typebox/value';

import assessmentSubmission from '../agent/assessment-submission.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';

describe('agent/assessment-submission', () => {
  it('should supply valid distinct envelopes for each entry and preserve revision custody', () => {
    const id = 'a'.repeat(64);
    const previousResultDigest = 'b'.repeat(64);
    const target = 'https://github.com/owner/repo/issues/3';
    for (const entry of ['managed', 'direct'] as const) {
      const submission = assessmentSubmission({ entry, id, target, previousResultDigest });
      assert.equal(submission.resultField, 'result');
      assert.deepEqual(submission.request, {
        action: entry === 'direct' ? 'assessment' : 'result',
        ...(entry === 'direct' ? { operation: 'result', target } : {}),
        id,
        previousResultDigest,
      });
      assert.ok(Value.Check(dispatchParameters, submission.refreshRequest));
      for (const outcome of [
        { outcome: 'plan-ready', assessment: 'Bounded finding.', plan: 'Complete plan.' },
        { outcome: 'clarification-needed', assessment: 'Unknown.', questions: ['Which caller?'] },
        {
          outcome: 'operator-setup-blocker',
          code: 'context-unavailable',
          remediation: 'Restore access.',
        },
      ]) {
        const candidate: Record<string, unknown> = {
          ...submission.request,
          [submission.resultField]: {
            version: 1,
            summary: 'A retained assessment.',
            fullAssessment: 'Complete original source, including uncertainty.',
            evidence: [],
            progress: { completed: [], remaining: [] },
            decision: {
              mode: outcome.outcome === 'plan-ready' ? 'work' : 'plan',
              reasons: ['Supported judgment from the retained source.'],
            },
            ...outcome,
          },
        };
        assert.ok(Value.Check(dispatchParameters, candidate));
        assert.equal(Value.Check(dispatchParameters, { ...candidate, authorized: true }), false);
        assert.equal(
          Value.Check(dispatchParameters, { ...candidate, decision: { mode: 'work' } }),
          false,
        );
      }
    }
  });
});
