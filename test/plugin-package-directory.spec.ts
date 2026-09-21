import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import resolvePluginPackageDirectory from '../core/plugin-package-directory.ts';

describe('core/plugin-package-directory', () => {
  it('should prefer the plugin source root over a generated runtime artifact', () => {
    const packageDir = '/checkout/openclaw-agent-system';
    const runtimeUrl = pathToFileURL(join('/runtime/generations/agent-system', 'index.js')).href;

    assert.equal(resolvePluginPackageDirectory(packageDir, runtimeUrl), packageDir);
  });

  it('should derive legacy source and built package roots from the runtime url', () => {
    assert.equal(
      resolvePluginPackageDirectory(undefined, 'file:///checkout/openclaw-agent-system/index.ts'),
      '/checkout/openclaw-agent-system',
    );
    assert.equal(
      resolvePluginPackageDirectory(
        undefined,
        'file:///plugins/openclaw-agent-system/dist/index.js',
      ),
      '/plugins/openclaw-agent-system',
    );
  });
});
