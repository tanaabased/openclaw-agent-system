import assert from 'node:assert/strict';

import loadCommandManifest from '../cli/load-command-manifest.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

describe('cli/load-command-manifest', () => {
  it('should stop unresolved, unmanaged, and invalid commands with diagnostics only', async () => {
    for (const status of ['unresolved', 'unmanaged', 'invalid'] as const) {
      const result: AgentManifestLoadResult = {
        status,
        scope: { workspaceDir: '/workspace' },
        diagnostics: [
          { code: 'manifest-test-error', message: 'Manifest failed.', severity: 'error' },
        ],
      };
      const output: string[] = [];
      const diagnostics: string[] = [];
      const exitCodes: number[] = [];
      const loaded = await loadCommandManifest({
        manifestService: {
          async loadForAgentId() {
            return result;
          },
          async loadForCommandDirectory() {
            return result;
          },
        },
        output: {
          writeStdout: (value) => output.push(value),
          writeStderr: (value) => diagnostics.push(value),
        },
        setExitCode: (code) => exitCodes.push(code),
        workspaceDir: '/workspace',
      });
      assert.equal(loaded, undefined);
      assert.deepEqual(exitCodes, [1]);
      assert.deepEqual(output, []);
      assert.match(diagnostics.join(''), /code=manifest-test-error/u);
    }
  });
});
