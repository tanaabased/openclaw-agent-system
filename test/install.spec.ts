import assert from 'node:assert/strict';

import installAgentSystem from '../cli/install.ts';
import type { AgentInstallResult } from '../lib/agent-install-service.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

const validResult: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
};

function createHarness(
  options: {
    install?: AgentInstallResult | Error;
    manifest?: AgentManifestLoadResult;
  } = {},
) {
  const output = { error: [] as string[], write: [] as string[] };
  const calls = {
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    workspace: [] as string[],
  };
  const exitCodes: number[] = [];

  return {
    calls,
    exitCodes,
    output,
    run: () =>
      installAgentSystem({
        installService: {
          async install(input) {
            calls.install.push(input);
            if (options.install instanceof Error) throw options.install;
            return (
              options.install ?? {
                actions: ['add-agent', 'set-identity'],
                agentId: 'tanaabot',
                workspaceDir: '/workspace',
              }
            );
          },
        },
        manifestService: {
          async loadForWorkspace(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.manifest ?? validResult;
          },
        },
        output: {
          error: (message) => output.error.push(message),
          write: (message) => output.write.push(message),
        },
        setExitCode: (code) => exitCodes.push(code),
        workspaceDir: '/current',
      }),
  };
}

describe('cli/install', () => {
  it('should install a loaded workspace manifest and report completed actions', async () => {
    const { calls, output, run } = createHarness();

    await run();

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.install, [
      { manifest: validResult.manifest, workspaceDir: '/workspace' },
    ]);
    assert.deepEqual(output.write, [
      'created: OpenClaw agent tanaabot at /workspace\n',
      'updated: OpenClaw identity for tanaabot\n',
    ]);
  });

  it('should report an unchanged installed agent', async () => {
    const { output, run } = createHarness({
      install: { actions: [], agentId: 'tanaabot', workspaceDir: '/workspace' },
    });

    await run();

    assert.deepEqual(output.write, [
      'unchanged: OpenClaw agent tanaabot is installed at /workspace\n',
    ]);
  });

  it('should report installation failures and set a failing exit code', async () => {
    const { exitCodes, output, run } = createHarness({
      install: new Error('agent workspace conflict'),
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output.error, ['error: agent workspace conflict\n']);
  });

  it('should not install an invalid workspace manifest', async () => {
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      path: '/current/agent.yaml',
      diagnostics: [],
    };
    const { calls, exitCodes, run } = createHarness({ manifest: invalid });

    await run();

    assert.deepEqual(calls.install, []);
    assert.deepEqual(exitCodes, [1]);
  });
});
