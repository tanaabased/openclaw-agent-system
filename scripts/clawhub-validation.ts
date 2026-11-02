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

// 10.8 has no equivalent public cold config reader; its final session guard is synchronous.
// keep exceptions api- and owner-specific, including only their emitted bundle entries.
const exceptions = [
  {
    api: 'api.runtime.agent.session.getSessionEntry',
    record: 'session-store-sync-readers',
    sources: ['tools/dispatch/tool.ts'],
    bundles: ['dist/index.js'],
  },
  {
    api: 'openclaw/plugin-sdk/runtime-config-snapshot.getRuntimeConfig',
    record: 'runtime-config-sync-load',
    sources: ['core/read-fresh-runtime-config.ts', 'environment/memory-secret-provider-entry.ts'],
    bundles: ['dist/index.js', 'dist/memory-secret-provider-entry.js'],
  },
];

function warningPath(evidence: string, api: string): string {
  const prefix = `${api} @ `;
  return evidence.startsWith(prefix) ? evidence.slice(prefix.length).replace(/:\d+$/u, '') : '';
}

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
  for (const issue of report.issues) {
    const exception =
      target.version === '2026.10.8' &&
      exceptions.find(
        (entry) => entry.api === issue.deprecatedApi && entry.record === issue.compatRecord,
      );
    assert.ok(
      exception &&
        issue.code === 'sdk-deprecated-api' &&
        issue.issueClass === 'deprecation-warning',
      `clawhub-unexpected-warning: ${issue.code}: ${issue.deprecatedApi ?? issue.compatRecord ?? ''}`,
    );
    const locations = issue.evidence.map((evidence) => warningPath(evidence, exception.api));
    assert.ok(
      locations.every(
        (path) => exception.sources.includes(path) || exception.bundles.includes(path),
      ),
      `clawhub-unexpected-warning-owner: ${issue.evidence.join(', ')}`,
    );
    // a bundled exception requires its source finding in the same inspected package.
    assert.ok(
      !locations.some((path) => exception.bundles.includes(path)) ||
        report.issues.some(
          (source) =>
            source.deprecatedApi === exception.api &&
            source.compatRecord === exception.record &&
            source.evidence.some((evidence) =>
              exception.sources.includes(warningPath(evidence, exception.api)),
            ),
        ),
      'clawhub-bundle-source-missing',
    );
  }
}
