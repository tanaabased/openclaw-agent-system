import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import executeAutomation from '../cli/automation-execute.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

describe('cli/automation-execute', () => {
  it('should abort bound execution on termination and remove its signal handlers', async () => {
    const workspaceDir = await realpath(await mkdtemp('/tmp/automation-execute-'));
    const loaded: AgentManifestLoadResult = {
      status: 'loaded',
      manifest: { schemaVersion: 1, agent: { id: 'a' } },
      scope: { workspaceDir, agentId: 'a' },
      path: `${workspaceDir}/agent.yaml`,
      digest: 'fixture',
      validationChecks: [],
      diagnostics: [],
    };
    const before = process.listenerCount('SIGTERM');
    let output = '';
    let disposed = false;
    try {
      const code = await executeAutomation({
        id: 'job',
        hash: 'a'.repeat(64),
        workspaceDir,
        manifestService: {
          loadForAgentId: async () => loaded,
          loadForCommandDirectory: async () => loaded,
        },
        automations: {
          admit: async () => ({
            command: { kind: 'exec', executable: 'true', args: [], timeoutSeconds: 10 },
            context: { agentId: 'a', workspaceDir },
          }),
        } as never,
        commands: {
          async run(_command: unknown, target: { mode?: string }, signal: AbortSignal) {
            assert.equal(target.mode, undefined);
            process.emit('SIGTERM', 'SIGTERM');
            assert.equal(signal.aborted, true);
            disposed = true;
            return { exitCode: null, timedOut: false, truncated: false };
          },
        } as never,
        output: {
          writeStdout: (text) => {
            output += text;
          },
          writeStderr: () => assert.fail('unexpected stderr'),
        },
      });
      assert.equal(code, 1);
      assert.equal(disposed, true);
      assert.equal(JSON.parse(output).code, 'automation-cancelled');
      assert.equal(process.listenerCount('SIGTERM'), before);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
