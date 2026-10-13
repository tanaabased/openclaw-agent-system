import assert from 'node:assert/strict';

import { parseAssessmentResult } from '../agent/assessment-result.ts';

describe('agent/assessment-result', () => {
  const common = {
    version: 1,
    summary: 'A bounded result.',
    evidence: [{ source: 'issue and repository', status: 'observed', detail: 'Verified context.' }],
    progress: { completed: ['Read the owning code.'], remaining: [] },
  };
  it('should preserve useful plans, requirement questions, and setup failures in one contract', () => {
    for (const outcome of [
      {
        outcome: 'plan-ready',
        assessment: 'Current behavior differs.',
        planSummary: 'Repair the shared owner.',
        plan: 'Change the owner and test the boundary.',
      },
      {
        outcome: 'plan-ready',
        assessment: 'Current behavior differs.',
        plan: 'Change the owner and test the boundary.',
      },
      {
        outcome: 'clarification-needed',
        assessment: 'Retention is unspecified.',
        questions: ['How long should records be kept?'],
      },
      {
        outcome: 'operator-setup-blocker',
        code: 'project-missing',
        remediation: 'Save the existing checkout as a project.',
      },
    ])
      assert.deepEqual(parseAssessmentResult({ ...common, ...outcome }), { ...common, ...outcome });
  });
  it('should reject prose-only state, empty outcomes, authority fields, and excessive output', () => {
    for (const invalid of [
      '## Plan ready',
      { ...common, outcome: 'plan-ready', assessment: 'Observed.', plan: ' ' },
      { ...common, outcome: 'plan-ready', assessment: 'Observed.', planSummary: 'A summary.' },
      ...[' ', 42].map((planSummary) => ({
        ...common,
        outcome: 'plan-ready',
        assessment: 'Observed.',
        planSummary,
        plan: 'Change the owner.',
      })),
      { ...common, outcome: 'clarification-needed', assessment: 'Observed.', questions: [] },
      {
        ...common,
        outcome: 'plan-ready',
        assessment: 'Observed.',
        plan: 'Do it.',
        implement: true,
      },
      { ...common, outcome: 'plan-ready', assessment: 'Observed.', plan: 'x'.repeat(32001) },
    ])
      assert.throws(() => parseAssessmentResult(invalid), /assessment-result-invalid/);
  });
});
