import assert from 'node:assert/strict';

import validateAgentSystem from '../cli/validate.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';

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
    agentId?: string;
    agent?: AgentManifestLoadResult;
    workspace?: AgentManifestLoadResult;
  } = {},
) {
  const logs = { error: [] as string[], info: [] as string[], warn: [] as string[] };
  const output: string[] = [];
  const calls = { agent: [] as string[], workspace: [] as string[] };
  const exitCodes: number[] = [];

  return {
    calls,
    exitCodes,
    logs,
    output,
    run: () =>
      validateAgentSystem({
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        logger: {
          error: (message) => logs.error.push(message),
          info: (message) => logs.info.push(message),
          warn: (message) => logs.warn.push(message),
        },
        manifestService: {
          async loadForAgentId(agentId) {
            calls.agent.push(agentId);
            return options.agent ?? validResult;
          },
          async loadForWorkspace(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.workspace ?? validResult;
          },
        },
        output: { writeStdout: (message) => output.push(message) },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles({ NO_COLOR: '1' }),
        workspaceDir: '/current',
      }),
  };
}

describe('cli/validate', () => {
  it('should validate the current workspace', async () => {
    const { calls, output, run } = createHarness();

    await run();

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(output, [
      'valid     Agent System manifest for tanaabot\nmanifest  /workspace/agent.yaml\n',
    ]);
  });

  it('should validate an explicit agent workspace', async () => {
    const { calls, run } = createHarness({ agentId: 'tanaabot' });

    await run();

    assert.deepEqual(calls.agent, ['tanaabot']);
    assert.deepEqual(calls.workspace, []);
  });

  it('should report an invalid manifest and set a failing exit code', async () => {
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      path: '/current/agent.yaml',
      diagnostics: [],
    };
    const { exitCodes, logs, run } = createHarness({ workspace: invalid });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.equal(logs.error.length > 0, true);
  });
});
