import assert from 'node:assert/strict';

import envAgentSystem from '../cli/env.ts';
import type { AgentEnvironmentLoadResult } from '../lib/agent-environment-service.ts';

const loaded: AgentEnvironmentLoadResult = {
  status: 'loaded',
  scope: { agentId: 'data', workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: {
    schemaVersion: 1,
    agent: { id: 'data' },
    environment: {
      set: { AGENT_COLOR: 'green', GITHUB_TOKEN: 'private-token' },
    },
  },
  environment: {
    values: { AGENT_COLOR: 'green', GITHUB_TOKEN: 'private-token' },
    variables: [
      { name: 'AGENT_COLOR', source: 'environment.set', staticExecDelivery: 'exec-candidate' },
      {
        name: 'GITHUB_TOKEN',
        source: 'environment.set',
        staticExecDelivery: 'documented-filtered',
      },
    ],
  },
  diagnostics: [],
};

function createHarness(
  options: {
    agentId?: string;
    json?: boolean;
    loadResult?: AgentEnvironmentLoadResult;
  } = {},
) {
  const calls = { agent: [] as string[], workspace: [] as string[] };
  const exitCodes: number[] = [];
  const output = { error: [] as string[], write: [] as string[] };
  return {
    calls,
    exitCodes,
    output,
    run: () =>
      envAgentSystem({
        ...(options.agentId ? { agentId: options.agentId } : {}),
        environmentService: {
          async loadForAgentId(agentId) {
            calls.agent.push(agentId);
            return options.loadResult ?? loaded;
          },
          async loadForWorkspace(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.loadResult ?? loaded;
          },
        },
        json: options.json ?? false,
        output: {
          error: (message) => output.error.push(message),
          write: (message) => output.write.push(message),
        },
        setExitCode: (code) => exitCodes.push(code),
        workspaceDir: '/current',
      }),
  };
}

describe('cli/env', () => {
  it('should inspect the current manifest without exposing literal values', async () => {
    const { calls, output, run } = createHarness({ json: true });

    await run();

    const serialized = output.write.join('');
    assert.deepEqual(calls.workspace, ['/current']);
    assert.equal(serialized.includes('AGENT_COLOR'), true);
    assert.equal(serialized.includes('exec-candidate'), true);
    assert.equal(serialized.includes('green'), false);
    assert.equal(serialized.includes('private-token'), false);
  });

  it('should inspect an explicit agent without using workspace discovery', async () => {
    const { calls, output, run } = createHarness({ agentId: 'data' });

    await run();

    assert.deepEqual(calls.agent, ['data']);
    assert.deepEqual(calls.workspace, []);
    assert.equal(output.write.join('').includes('AGENT_COLOR'), true);
  });

  it('should fail when the manifest is invalid', async () => {
    const invalid: AgentEnvironmentLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      diagnostics: [],
    };
    const { exitCodes, run } = createHarness({ loadResult: invalid });

    await run();

    assert.deepEqual(exitCodes, [1]);
  });
});
