import assert from 'node:assert/strict';
import { delimiter } from 'node:path';

import {
  classifyCodexPathConfig,
  inspectCodexPathConfig,
  manualCodexPathMarker,
  renderCodexPathConfig,
} from '../utils/codex-path-config.ts';

const projection = {
  entries: [
    { path: '/workspace/bin', source: 'workspace.bin' as const },
    { path: '/package/bin', source: 'agent-system.bin' as const },
  ],
  path: ['/workspace/bin', '/package/bin', '/usr/bin'].join(delimiter),
};

describe('utils/codex-path-config', () => {
  it('should render a managed literal path configuration', () => {
    const source = renderCodexPathConfig(projection.path);

    assert.equal(classifyCodexPathConfig(source), 'managed');
    assert.equal(source.includes('shell_snapshot = true'), true);
    assert.equal(source.includes('inherit = "all"'), true);
    assert.deepEqual(inspectCodexPathConfig(source, projection), {
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
      ownership: 'managed',
      pathMatches: false,
    });
  });
});
