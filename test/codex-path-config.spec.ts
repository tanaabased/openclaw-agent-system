import assert from 'node:assert/strict';
import { delimiter } from 'node:path';

import {
  classifyCodexPathConfig,
  inspectCodexPathConfig,
  manualCodexPathMarker,
  renderCodexPathConfig,
} from '../paths/codex-config.ts';

const projection = {
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
      loginShellDisabled: true,
      ownership: 'managed',
      pathMatches: true,
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
      loginShellDisabled: true,
      ownership: 'managed',
      pathMatches: false,
    });
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
