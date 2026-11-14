import assert from 'node:assert/strict';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

const reportSchema = Type.Object({
  status: Type.String(),
  targetOpenClaw: Type.Object({
    status: Type.String(),
    configuredPath: Type.String(),
    version: Type.String(),
  }),
  summary: Type.Object({
    breakageCount: Type.Integer({ minimum: 0 }),
    warningCount: Type.Integer({ minimum: 0 }),
  }),
  issues: Type.Array(
    Type.Object({
      code: Type.String(),
      issueClass: Type.String(),
      compatRecord: Type.Optional(Type.String()),
      deprecatedApi: Type.Optional(Type.String()),
      evidence: Type.Array(Type.String(), { minItems: 1 }),
    }),
  ),
});

export default function validateClawHubReport(
  report: unknown,
  target: { path: string; version: string },
): void {
  assert.ok(Value.Check(reportSchema, report), 'clawhub-report-invalid');
  assert.equal(report.status, 'pass', 'clawhub-validation-failed');
  assert.equal(report.targetOpenClaw.status, 'ok', 'clawhub-target-unavailable');
  assert.equal(report.targetOpenClaw.configuredPath, target.path, 'clawhub-target-mismatch');
  assert.equal(report.targetOpenClaw.version, target.version, 'clawhub-version-mismatch');
  assert.equal(report.summary.breakageCount, 0, 'clawhub-breakages');
  assert.equal(report.issues.length, report.summary.warningCount, 'clawhub-findings-mismatch');
  assert.equal(report.issues.length, 0, 'clawhub-unexpected-warning');
}
