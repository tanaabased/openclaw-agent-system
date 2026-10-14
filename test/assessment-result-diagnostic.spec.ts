import assert from 'node:assert/strict';

import assessmentResultDiagnostic from '../agent/assessment-result-diagnostic.ts';
import { parseAssessmentResult } from '../agent/assessment-result.ts';

describe('agent/assessment-result-diagnostic', () => {
  const blocker = {
    version: 1,
    outcome: 'operator-setup-blocker',
    summary: 'Blocked.',
    code: 'editor-unavailable',
    remediation: 'Enable the editor.',
    evidence: [],
    progress: { completed: [], remaining: [] },
  };
  it('should explain only the selected outcome while preserving strict submission validation', () => {
    const invalid = { ...blocker, assessment: 'SECRET investigation' };
    const report = assessmentResultDiagnostic(invalid);
    assert.equal(report.valid, false);
    assert.deepEqual(report.unexpectedFields, ['assessment']);
    assert.deepEqual(report.missingFields, []);
    assert.equal(report.allowedFields?.includes('plan'), false);
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    assert.throws(() => parseAssessmentResult(invalid), /assessment-result-invalid/);
    assert.equal(assessmentResultDiagnostic(blocker).valid, true);
  });
  it('should identify missing, invalid, unsupported and oversized fields without echoing values', () => {
    const report = assessmentResultDiagnostic({
      ...blocker,
      remediation: undefined,
      progress: { completed: 'SECRET' },
      'SECRET KEY': 'SECRET VALUE',
    });
    assert.deepEqual(report.invalidFields, ['progress', 'remediation']);
    assert.deepEqual(report.unexpectedFields, ['<unknown field>']);
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    const { remediation, ...missing } = blocker;
    assert.deepEqual(assessmentResultDiagnostic(missing).missingFields, ['remediation']);
    assert.equal(remediation.length > 0, true);
    assert.equal(assessmentResultDiagnostic({ outcome: 'SECRET' }).valid, false);
    assert.equal(assessmentResultDiagnostic(null).valid, false);
    assert.equal(
      assessmentResultDiagnostic({ ...blocker, summary: 'x'.repeat(96001) }).exceedsSizeLimit,
      true,
    );
  });
});
