import assert from 'node:assert/strict';

import envAgentSystem from '../cli/env.ts';
import type { AgentEnvironmentLoadResult } from '../environment/service.ts';
import { createCliStyles } from '../cli/output.ts';

const loaded: AgentEnvironmentLoadResult = {
  status: 'loaded',
  scope: { agentId: 'data', workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: {
    schemaVersion: 1,
    agent: { id: 'data' },
    environment: {
      required: ['AGENT_COLOR'],
      set: { AGENT_COLOR: 'green', GITHUB_TOKEN: 'private-token' },
    },
  },
  environment: {
    sensitiveNames: ['GITHUB_TOKEN'],
    values: { AGENT_COLOR: 'green', GITHUB_TOKEN: 'private-token' },
    variables: [
      {
        name: 'AGENT_COLOR',
        overriddenSources: [],
        required: true,
        source: 'environment.set',
      },
      {
        name: 'GITHUB_TOKEN',
        overriddenSources: [],
        required: false,
        source: 'environment.set',
      },
    ],
  },
  diagnostics: [],
  validationChecks: [],
};

function createHarness(
  options: {
    agentId?: string;
    json?: boolean;
    loadResult?: AgentEnvironmentLoadResult;
    terminalColumns?: number;
  } = {},
) {
  const calls = { agent: [] as string[], workspace: [] as string[] };
  const diagnostics: string[] = [];
  const exitCodes: number[] = [];
  const output: string[] = [];
  return {
    calls,
    diagnostics,
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
          async loadForCommandDirectory(workspaceDir) {
            calls.workspace.push(workspaceDir);
            return options.loadResult ?? loaded;
          },
        },
        json: options.json ?? false,
        output: {
          writeStderr: (message) => diagnostics.push(message),
          writeStdout: (message) => output.push(message),
        },
        setExitCode: (code) => exitCodes.push(code),
        styles: createCliStyles({ NO_COLOR: '1' }),
        terminalColumns: options.terminalColumns,
        workspaceDir: '/current',
      }),
  };
}

describe('cli/env', () => {
  it('should inspect the nearest manifest without exposing resolved values', async () => {
    const { calls, output, run } = createHarness({ json: true });

    await run();

    const serialized = output.join('');
    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(JSON.parse(serialized).variables, [
      {
        name: 'AGENT_COLOR',
        overriddenSources: [],
        required: true,
        source: 'environment.set',
      },
      {
        name: 'GITHUB_TOKEN',
        overriddenSources: [],
        required: false,
        source: 'environment.set',
      },
    ]);
    assert.equal(serialized.includes('green'), false);
    assert.equal(serialized.includes('private-token'), false);
    assert.equal(serialized.includes('sensitiveNames'), false);
  });

  it('should show a compact metadata table and the selected workspace', async () => {
    const { output, run } = createHarness();

    await run();

    assert.match(output.join(''), /AGENT_COLOR\s+environment\.set\s+true\s+0/u);
    assert.match(
      output.join(''),
      /agent\s+data[\s\S]*manifest\s+\/workspace\/agent\.yaml[\s\S]*workspace\s+\/workspace/u,
    );
    assert.match(output.join(''), /variable\s+source\s+required\s+overrides/u);
    assert.equal(output.join('').includes('green'), false);
    assert.equal(output.join('').includes('private-token'), false);
  });

  it('should show an explicit empty result and preserve long literal names in narrow previews', async () => {
    const empty: AgentEnvironmentLoadResult = {
      ...loaded,
      environment: { ...loaded.environment, variables: [] },
    };
    const emptyFixture = createHarness({ loadResult: empty });
    await emptyFixture.run();
    assert.match(emptyFixture.output.join(''), /no environment variables/u);
    assert.match(emptyFixture.output.join(''), /variable\s+source\s+required\s+overrides/u);

    const variableName = 'MiXeD_CASE_VERY_LONG_ENVIRONMENT_VARIABLE_NAME';
    const overridden: AgentEnvironmentLoadResult = {
      ...loaded,
      environment: {
        ...loaded.environment,
        variables: [
          {
            name: variableName,
            source: 'environment.dotenv[12]',
            required: true,
            overriddenSources: ['environment.set'],
          },
        ],
      },
    };
    const narrow = createHarness({ loadResult: overridden, terminalColumns: 24 });
    await narrow.run();
    const text = narrow.output.join('');
    const compact = text.replace(/\s/gu, '');
    assert.ok(compact.includes(variableName));
    assert.ok(compact.includes('environment.dotenv[12]'));
    assert.match(text, /overrides: 1/u);
    assert.equal(text.includes('private-token'), false);
    assert.equal(text.includes('green'), false);
    assert.ok(text.split('\n').every((line) => line.length <= 24));
  });

  it('should inspect an explicit agent without using workspace discovery', async () => {
    const { calls, output, run } = createHarness({ agentId: 'data' });

    await run();

    assert.deepEqual(calls.agent, ['data']);
    assert.deepEqual(calls.workspace, []);
    assert.equal(output.join('').includes('AGENT_COLOR'), true);
  });

  it('should fail when the manifest is invalid', async () => {
    const invalid: AgentEnvironmentLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      diagnostics: [],
    };
    const { diagnostics, exitCodes, output, run } = createHarness({ loadResult: invalid });

    await run();

    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(output, []);
    assert.match(diagnostics.join(''), /invalid Agent System manifest/u);
  });
});
