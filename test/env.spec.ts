import assert from 'node:assert/strict';

import envAgentSystem from '../cli/env.ts';
import type { AgentEnvironmentLoadResult } from '../lib/agent-environment-service.ts';
import type AgentExecProbeService from '../lib/agent-exec-probe-service.ts';

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
    exec?: boolean;
    json?: boolean;
    loadResult?: AgentEnvironmentLoadResult;
    probeResult?: Awaited<ReturnType<AgentExecProbeService['probe']>>;
  } = {},
) {
  const calls = { agent: [] as string[], probe: 0, workspace: [] as string[] };
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
        exec: options.exec ?? false,
        execProbeService: {
          async probe() {
            calls.probe += 1;
            return (
              options.probeResult ?? {
                status: 'completed',
                variables:
                  loaded.status === 'loaded'
                    ? loaded.environment.variables.map((variable) => ({
                        ...variable,
                        observedExecDelivery: 'accepted' as const,
                      }))
                    : [],
              }
            );
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
    assert.equal(calls.probe, 0);
    assert.equal(serialized.includes('AGENT_COLOR'), true);
    assert.equal(serialized.includes('exec-candidate'), true);
    assert.equal(serialized.includes('green'), false);
    assert.equal(serialized.includes('private-token'), false);
  });

  it('should inspect an explicit agent and include observed exec delivery', async () => {
    const { calls, output, run } = createHarness({ agentId: 'data', exec: true });

    await run();

    assert.deepEqual(calls.agent, ['data']);
    assert.equal(calls.probe, 1);
    assert.equal(output.write.join('').includes('observed=accepted'), true);
  });

  it('should explain the security opt-in and preserve current allow entries', async () => {
    const { exitCodes, output, run } = createHarness({
      exec: true,
      probeResult: {
        status: 'disabled',
        code: 'exec-probe-disabled',
        enableCommand: `openclaw config set gateway.tools.allow '["browser","exec"]' --strict-json`,
      },
    });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.equal(output.error.join('').includes('authenticated operator clients'), true);
    assert.equal(output.error.join('').includes('["browser","exec"]'), true);
    assert.equal(output.error.join('').includes('private-token'), false);
  });

  it('should preserve the security explanation in JSON failure output', async () => {
    const { exitCodes, output, run } = createHarness({
      exec: true,
      json: true,
      probeResult: {
        status: 'disabled',
        code: 'exec-probe-disabled',
        enableCommand: `openclaw config set gateway.tools.allow '["exec"]' --strict-json`,
      },
    });

    await run();

    const result = JSON.parse(output.write.join('')) as {
      execProbe: { restartRequired?: boolean; securityImplication?: string };
    };
    assert.deepEqual(exitCodes, [1]);
    assert.equal(result.execProbe.restartRequired, true);
    assert.equal(result.execProbe.securityImplication?.includes('shell commands'), true);
  });

  it('should fail before probing when the manifest is invalid', async () => {
    const invalid: AgentEnvironmentLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      diagnostics: [],
    };
    const { calls, exitCodes, run } = createHarness({ exec: true, loadResult: invalid });

    await run();

    assert.equal(calls.probe, 0);
    assert.deepEqual(exitCodes, [1]);
  });
});
