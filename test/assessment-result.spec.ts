import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import {
  assessmentResultContextSchema,
  parseAssessmentSubmission,
} from '../agent/tasks/assessment/assessment-result.ts';
import AssessmentValidationError from '../agent/tasks/assessment/assessment-validation.ts';
import { assertDispatchModelRequest } from '../tools/dispatch/tool-schema.ts';

describe('agent/assessment-result', () => {
  it('should accept display-only plans, questions and blockers at the public tool boundary', () => {
    for (const result of [
      { outcome: 'plan-ready', summary: 'Repair the shared owner.' },
      { outcome: 'clarification-needed', summary: 'Choose retention.', questions: ['How long?'] },
      {
        outcome: 'operator-setup-blocker',
        summary: 'Checkout unavailable.',
        code: 'checkout-missing',
        remediation: 'Restore the checkout.',
      },
    ]) {
      assert.equal(Value.Check(assessmentResultContextSchema, result), true);
      assert.deepEqual(parseAssessmentSubmission(result), result);
      assert.doesNotThrow(() =>
        assertDispatchModelRequest({
          action: 'assessment',
          operation: 'render',
          target: 'https://github.com/owner/repo/issues/3',
          result,
        }),
      );
    }
  });
  it('should reject authority overrides and malformed display content without leaking private fields', () => {
    const result = { outcome: 'plan-ready', summary: 'Repair the shared owner.' };
    for (const invalid of [
      { ...result, summary: ' ' },
      { ...result, 'PRIVATE-KEY': 'PRIVATE-VALUE' },
      { ...result, fullAssessment: 'Unnecessary source copy.' },
      { ...result, authorized: true },
      { ...result, decision: { mode: 'work', reasons: [] } },
      { outcome: 'clarification-needed', summary: 'Choose retention.', questions: [] },
    ])
      assert.throws(
        () => parseAssessmentSubmission(invalid),
        (error: unknown) => {
          assert.ok(error instanceof AssessmentValidationError);
          assert.doesNotMatch(error.message + JSON.stringify(error.recovery), /PRIVATE-/);
          return true;
        },
      );
  });
  it('should preserve a reasoned decision without granting permission or hiding questions', () => {
    for (const mode of ['plan', 'work'] as const) {
      const result = {
        outcome: 'plan-ready',
        summary: 'Repair it.',
        decision: { mode, reasons: ['Scope verified.'] },
      };
      assert.deepEqual(parseAssessmentSubmission(result), result);
    }
    assert.throws(
      () =>
        parseAssessmentSubmission({
          outcome: 'clarification-needed',
          summary: 'Choose retention.',
          questions: ['How long?'],
          decision: { mode: 'work', reasons: ['Try anyway.'] },
        }),
      /assessment-decision-conflict/,
    );
  });
});
