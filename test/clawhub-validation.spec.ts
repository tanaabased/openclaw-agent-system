import assert from 'node:assert/strict';

import validateClawHubReport from '../scripts/clawhub-validation.ts';

describe('scripts/clawhub-validation', () => {
  const target = { path: '/sdk/openclaw', version: '2026.10.8' };
  function warning(api: string, record: string, path: string) {
    return {
      code: 'sdk-deprecated-api',
      issueClass: 'deprecation-warning',
      compatRecord: record,
      deprecatedApi: api,
      evidence: [`${api} @ ${path}:47`],
    };
  }
  const config = (path = 'core/read-fresh-runtime-config.ts') =>
    warning(
      'openclaw/plugin-sdk/runtime-config-snapshot.getRuntimeConfig',
      'runtime-config-sync-load',
      path,
    );
  const session = (path = 'tools/dispatch/tool.ts') =>
    warning('api.runtime.agent.session.getSessionEntry', 'session-store-sync-readers', path);
  function report(issues: ReturnType<typeof warning>[] = []) {
    return {
      status: 'pass',
      targetOpenClaw: { status: 'ok', configuredPath: target.path, version: target.version },
      summary: { breakageCount: 0, warningCount: issues.length },
      issues,
    };
  }

  it('should accept a fully inspected clean report', () => {
    validateClawHubReport(report(), target);
  });

  it('should accept only the owned 10.8 config and final session exceptions with their bundles', () => {
    validateClawHubReport(
      report([
        config(),
        config('environment/memory-secret-provider-entry.ts'),
        config('dist/index.js'),
        config('dist/memory-secret-provider-entry.js'),
        session(),
        session('dist/index.js'),
      ]),
      target,
    );
  });

  it('should reject new APIs owners records and non-deprecation warnings', () => {
    for (const issue of [
      warning('different.api', 'runtime-config-sync-load', 'core/read-fresh-runtime-config.ts'),
      config('environment/unrelated.ts'),
      session('core/register-agent-system.ts'),
      { ...config(), compatRecord: 'different-record' },
      { ...config(), code: 'some-other-warning' },
      { ...config(), issueClass: 'compat-warning' },
      { ...config(), evidence: [] },
      { ...config(), evidence: ['unrecognized evidence'] },
      config('dist/other.js'),
    ])
      assert.throws(() => validateClawHubReport(report([issue]), target), /clawhub-/);
  });

  it('should reject an orphaned bundled exception', () => {
    assert.throws(
      () => validateClawHubReport(report([config('dist/index.js')]), target),
      /bundle-source-missing/,
    );
  });

  it('should reject malformed missing mismatched or uninspected reports', () => {
    for (const value of [
      null,
      {},
      { ...report(), issues: undefined },
      { ...report(), targetOpenClaw: { status: 'missing' } },
      { ...report(), status: 'fail' },
      { ...report(), targetOpenClaw: { ...report().targetOpenClaw, status: 'missing' } },
      { ...report(), targetOpenClaw: { ...report().targetOpenClaw, configuredPath: '/elsewhere' } },
      { ...report(), targetOpenClaw: { ...report().targetOpenClaw, version: '2026.10.6' } },
      { ...report(), summary: { breakageCount: 1, warningCount: 0 } },
      { ...report(), summary: { breakageCount: 0, warningCount: 1 } },
      { ...report(), summary: { breakageCount: 0, warningCount: -1 } },
    ])
      assert.throws(() => validateClawHubReport(value, target), /clawhub-/);
  });

  it('should not carry 10.8 exceptions into a different sdk target', () => {
    const value = report([config()]);
    value.targetOpenClaw.version = '2027.1.1';
    assert.throws(
      () => validateClawHubReport(value, { ...target, version: '2027.1.1' }),
      /unexpected-warning/,
    );
  });
});
