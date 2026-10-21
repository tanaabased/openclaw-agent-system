import assert from 'node:assert/strict';

import { Value } from 'typebox/value';

import {
  assessmentResultContextSchema,
  assessmentDecisionMode,
  parseAssessmentResult,
} from '../agent/assessment-result.ts';

describe('agent/assessment-result', () => {
  const common = {
    version: 1,
    summary: 'A bounded result.',
    evidence: [{ source: 'issue and repository', status: 'observed', detail: 'Verified context.' }],
    progress: { completed: ['Read the owning code.'], remaining: [] },
  };
  it('should retain bounded decisions without accepting permission or conflicting outcomes', () => {
    const plan = {
      ...common,
      outcome: 'plan-ready',
      assessment: 'Observed.',
      plan: 'Small change.',
    };
    for (const action of ['proceed', 'wait']) {
      const value = { ...plan, decision: { action, reasons: ['The scope is understood.'] } };
      assert.deepEqual(parseAssessmentResult(value), value);
    }
    for (const mode of ['plan', 'work'] as const) {
      const value = { ...plan, decision: { mode, reasons: ['The scope is understood.'] } };
      assert.deepEqual(parseAssessmentResult(value), value);
      assert.equal(assessmentDecisionMode(value.decision), mode);
      assert.equal(
        Value.Check(JSON.parse(JSON.stringify(assessmentResultContextSchema)), value),
        true,
      );
    }
    for (const action of ['wait', 'proceed'] as const) {
      const value = { ...plan, decision: { action, reasons: ['Legacy decision.'] } };
      const source = JSON.stringify(value);
      assert.equal(
        assessmentDecisionMode(parseAssessmentResult(value).decision),
        action === 'wait' ? 'plan' : 'work',
      );
      assert.equal(JSON.stringify(value), source);
      assert.equal(
        Value.Check(JSON.parse(JSON.stringify(assessmentResultContextSchema)), value),
        false,
      );
    }
    for (const decision of [
      { action: 'proceed', reasons: [] },
      { action: 'proceed', reasons: [' '] },
      { action: 'proceed', reasons: ['x'.repeat(1001)] },
      { action: 'proceed', reasons: Array(6).fill('Reason') },
      { mode: 'auto', reasons: ['Choose later.'] },
      { mode: 'work', action: 'wait', reasons: ['Conflicting.'] },
      { action: 'allow', reasons: ['The issue asks for permission.'] },
      { action: 'proceed', reasons: ['Clear.'], authorized: true },
    ])
      assert.throws(
        () => parseAssessmentResult({ ...plan, decision }),
        /assessment-result-invalid/,
      );
    assert.throws(
      () =>
        parseAssessmentResult({
          ...common,
          outcome: 'clarification-needed',
          assessment: 'Unknown retention.',
          questions: ['How long?'],
          decision: { action: 'proceed', reasons: ['Try anyway.'] },
        }),
      /assessment-decision-conflict/,
    );
  });
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
    ]) {
      const input = { ...common, ...outcome };
      assert.deepEqual(parseAssessmentResult(input), input);
      const contract = JSON.parse(JSON.stringify(assessmentResultContextSchema));
      assert.equal(Value.Check(contract, input), true);
      assert.equal(Value.Check(contract, { ...input, version: 2 }), false);
      assert.equal(Value.Check(contract, { ...input, implement: true }), false);
    }
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
      ...[' ', 42, 'x'.repeat(32001)].map((reviewSummary) => ({
        ...common,
        outcome: 'plan-ready',
        assessment: 'Observed.',
        plan: 'Do it.',
        reviewSummary,
      })),
      ...[' ', 42, 'x'.repeat(32001)].map((fullAssessment) => ({
        ...common,
        outcome: 'plan-ready',
        assessment: 'Observed.',
        plan: 'Do it.',
        fullAssessment,
      })),
    ])
      assert.throws(() => parseAssessmentResult(invalid), /assessment-result-invalid/);
  });

  it('should preserve the complete source in the same contract for every outcome', () => {
    const fullAssessment =
      'Delete records only after retention is confirmed.\n\nThe failure cause is not verified.\n\nKeep this partial plan while asking for a decision.';
    for (const outcome of [
      { outcome: 'plan-ready', assessment: 'Confirmed retention.', plan: fullAssessment },
      {
        outcome: 'clarification-needed',
        assessment: 'Retention is unresolved.',
        questions: ['Which retention period applies?'],
      },
      {
        outcome: 'operator-setup-blocker',
        code: 'assessment-output-unusable',
        remediation: 'Retry the incomplete assessment in this chat.',
      },
    ]) {
      const input = {
        ...common,
        ...outcome,
        fullAssessment,
        reviewSummary: 'User journey and documentation/test impact.',
      };
      assert.equal(
        Value.Check(JSON.parse(JSON.stringify(assessmentResultContextSchema)), input),
        true,
      );
      assert.deepEqual(parseAssessmentResult(input), input);
    }
  });
});
