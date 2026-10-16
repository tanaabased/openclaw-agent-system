import assert from 'node:assert/strict';
import refresh from '../channels/github/cli/refresh.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'fixture',
  manifest: { schemaVersion: 1, agent: { id: 'receiver' } },
  diagnostics: [],
  validationChecks: [],
};

describe('channels/github/cli/refresh', () => {
  it('should forward a bounded native request and write one queued json receipt', async () => {
    const stdout: string[] = [];
    await refresh({
      json: true,
      workspaceDir: '/workspace',
      timeoutSeconds: '45',
      manifestService: {
        loadForAgentId: async () => loaded,
        loadForCommandDirectory: async () => loaded,
      },
      nativeService: {
        async refresh(manifest, workspace, input) {
          assert.equal(manifest.agent.id, 'receiver');
          assert.equal(workspace, '/workspace');
          assert.ok(input.signal instanceof AbortSignal);
          assert.equal(input.signal.aborted, false);
          return {
            agentId: 'receiver',
            code: 'github-notification-refresh-queued',
            runId: 'native-run',
            status: 'queued',
          };
        },
      },
      output: {
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => assert.fail(text),
      },
      setExitCode: (code) => assert.fail(`unexpected exit ${code}`),
    });
    assert.deepEqual(JSON.parse(stdout.join('')), {
      agentId: 'receiver',
      code: 'github-notification-refresh-queued',
      runId: 'native-run',
      status: 'queued',
    });
  });
  it('should reject an invalid timeout before loading or queueing', async () => {
    let exit = 0;
    const diagnostics: string[] = [];
    const never = async (): Promise<never> => assert.fail('must reject before manifest loading');
    await refresh({
      json: true,
      workspaceDir: '/workspace',
      timeoutSeconds: '2147484',
      manifestService: { loadForAgentId: never, loadForCommandDirectory: never },
      output: {
        writeStdout: () => assert.fail('no json result'),
        writeStderr: (text) => diagnostics.push(text),
      },
      setExitCode: (code) => {
        exit = code;
      },
    });
    assert.equal(exit, 2);
    assert.match(diagnostics.join(''), /github-notification-refresh-options-invalid/u);
  });
});
