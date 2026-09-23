import assert from 'node:assert/strict';
import { delimiter } from 'node:path';

import {
  classifyCodexPathConfig,
  inspectCodexPathConfig,
  manualCodexPathMarker,
  renderCodexPathConfig,
} from '../paths/codex-config.ts';

const projection = {
  baseline: ['/usr/bin'],
  entries: [
    { path: '/workspace/bin', source: 'workspace.bin' as const },
    { path: '/package/bin', source: 'agent-system.bin' as const },
  ],
  path: ['/workspace/bin', '/package/bin', '/usr/bin'].join(delimiter),
};

describe('paths/codex-config', () => {
  it('should render a managed literal path configuration', () => {
    const source = renderCodexPathConfig(projection.path);

    assert.equal(classifyCodexPathConfig(source), 'managed');
    assert.equal(source.includes('allow_login_shell = false'), true);
    assert.equal(source.includes('shell_snapshot = true'), true);
    assert.equal(source.includes('inherit = "all"'), false);
    assert.deepEqual(inspectCodexPathConfig(source, projection), {
      baseline: ['/usr/bin'],
      loginShellDisabled: true,
      managedPrefixesMatch: true,
      missingBaselineEntries: [],
      ownership: 'managed',
      pathMatches: true,
      pathStatus: 'valid',
    });
  });

  it('should distinguish acknowledged and unmarked manual configuration', () => {
    assert.equal(classifyCodexPathConfig(`${manualCodexPathMarker}\n`), 'manual');
    assert.equal(classifyCodexPathConfig('[features]\nshell_snapshot = true\n'), 'user');
  });

  it('should report managed path drift without evaluating toml', () => {
    const source = renderCodexPathConfig(
      ['/workspace/bin', '/package/bin', '/other/bin'].join(delimiter),
    );

    assert.deepEqual(inspectCodexPathConfig(source, projection), {
      baseline: ['/other/bin'],
      loginShellDisabled: true,
      managedPrefixesMatch: true,
      missingBaselineEntries: ['/usr/bin'],
      ownership: 'managed',
      pathMatches: false,
      pathStatus: 'valid',
    });
  });

  it('should accept extra saved baseline entries regardless of caller order', () => {
    const saved = renderCodexPathConfig(
      ['/workspace/bin', '/package/bin', '/usr/bin', '/opt/bin'].join(delimiter),
    );
    const reorderedCaller = {
      ...projection,
      baseline: ['/opt/bin', '/usr/bin'],
      path: ['/workspace/bin', '/package/bin', '/opt/bin', '/usr/bin'].join(delimiter),
    };

    const inspection = inspectCodexPathConfig(saved, reorderedCaller);

    assert.equal(inspection.pathMatches, true);
    assert.deepEqual(inspection.baseline, ['/usr/bin', '/opt/bin']);
  });

  it('should distinguish malformed PATH from a missing setting', () => {
    const malformed = renderCodexPathConfig(projection.path).replace(
      `PATH = ${JSON.stringify(projection.path)}`,
      'PATH = ["broken"]',
    );
    const missing = renderCodexPathConfig(projection.path).replace(/^PATH = .*$/mu, '');

    assert.equal(inspectCodexPathConfig(malformed, projection).pathStatus, 'malformed');
    assert.equal(inspectCodexPathConfig(missing, projection).pathStatus, 'missing');
  });

  it('should inspect only the root login-shell setting', () => {
    const manualSource = `${manualCodexPathMarker}
allow_login_shell = false

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = ${JSON.stringify(projection.path)}
`;
    const nestedSource = manualSource.replace(
      'allow_login_shell = false\n\n[features]',
      '[custom]\nallow_login_shell = false\n\n[features]',
    );

    assert.equal(inspectCodexPathConfig(manualSource, projection).loginShellDisabled, true);
    assert.equal(inspectCodexPathConfig(nestedSource, projection).loginShellDisabled, false);
  });
});
