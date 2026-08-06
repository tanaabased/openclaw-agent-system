import assert from 'node:assert/strict';

import { Command } from 'commander';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import type { AgentEnvironmentLoadResult } from '../lib/agent-environment-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';
import registerAgentSystemCli from '../lib/register-cli.ts';

const validResult: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
};
const validEnvironmentResult: Extract<AgentEnvironmentLoadResult, { status: 'loaded' }> = {
  ...validResult,
  status: 'loaded',
  environment: {
    values: { AGENT_COLOR: 'green' },
    variables: [
      {
        name: 'AGENT_COLOR',
        overriddenSources: [],
        required: false,
        source: 'environment.set',
      },
    ],
  },
};

function createProgram() {
  const logs = { error: [] as string[], info: [] as string[], warn: [] as string[] };
  const output: string[] = [];
  const calls = {
    agent: [] as string[],
    credentialSet: [] as Array<{ agentId: string; storeId: string }>,
    credentialUnset: [] as Array<{ agentId: string; storeId: string }>,
    credentialValidate: [] as Array<{ agentId: string; storeId?: string }>,
    environmentAgent: [] as string[],
    environmentWorkspace: [] as string[],
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    workspace: [] as string[],
  };
  const program = new Command();
  program.name('openclaw').exitOverride();
  registerAgentSystemCli(program, {
    cwd: () => '/current',
    credentialManager: {
      async setFromEnvironment(manifest, storeId) {
        calls.credentialSet.push({ agentId: manifest.agent.id, storeId });
        return { status: 'stored', agentId: manifest.agent.id, storeId };
      },
      async unset(agentId, storeId) {
        calls.credentialUnset.push({ agentId, storeId });
        return { status: 'removed', agentId, storeId };
      },
      async validate(manifest, storeId) {
        calls.credentialValidate.push({
          agentId: manifest.agent.id,
          ...(storeId === undefined ? {} : { storeId }),
        });
        return {
          status: 'valid',
          agentId: manifest.agent.id,
          environmentCount: 1,
          source: storeId ? `store:${storeId}` : 'process-environment',
        };
      },
    },
    environmentService: {
      async loadForAgentId(agentId) {
        calls.environmentAgent.push(agentId);
        return validEnvironmentResult;
      },
      async loadForWorkspace(workspaceDir) {
        calls.environmentWorkspace.push(workspaceDir);
        return validEnvironmentResult;
      },
    },
    installService: {
      async install(input) {
        calls.install.push(input);
        return { actions: [], agentId: 'tanaabot', workspaceDir: '/workspace' };
      },
    },
    logger: {
      error: (message) => logs.error.push(message),
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    manifestService: {
      async loadForAgentId(agentId) {
        calls.agent.push(agentId);
        return validResult;
      },
      async loadForWorkspace(workspaceDir) {
        calls.workspace.push(workspaceDir);
        return validResult;
      },
    },
    output: { writeStdout: (message) => output.push(message) },
    styles: createCliStyles({ NO_COLOR: '1' }),
  });
  return { calls, logs, output, program };
}

describe('lib/register-cli', () => {
  it('should register agent-system with the as alias and owned subcommands', () => {
    const command = createProgram().program.commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
    assert.deepEqual(
      command?.commands.map((subcommand) => subcommand.name()),
      ['validate', 'env', 'credentials', 'install'],
    );
  });

  it('should show command help when invoked without a subcommand', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system']);

    assert.equal(output.join('').includes('validate'), true);
    assert.equal(output.join('').includes('install'), true);
    assert.equal(output.join('').includes('env'), true);
    assert.equal(output.join('').includes('credentials'), true);
  });

  it('should delegate environment inspection with explicit agent and json options', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'env',
      '--agent',
      'data',
      '--json',
    ]);

    assert.deepEqual(calls.environmentAgent, ['data']);
  });

  it('should delegate workspace validation from the current directory', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'validate']);

    assert.deepEqual(calls.workspace, ['/current']);
  });

  it('should pass an explicit agent through the short alias', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'as', 'validate', '--agent', 'tanaabot']);

    assert.deepEqual(calls.agent, ['tanaabot']);
  });

  it('should delegate installation for the current workspace manifest', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'install']);

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(calls.install, [
      { manifest: validResult.manifest, workspaceDir: '/workspace' },
    ]);
  });

  it('should delegate credential storage from the process environment', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'set',
      'op',
      '--store',
      'file',
      '--from-env',
    ]);

    assert.deepEqual(calls.credentialSet, [{ agentId: 'tanaabot', storeId: 'file' }]);
  });

  it('should delegate exact-store credential validation for an agent', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'agent-system',
      'credentials',
      'validate',
      'op',
      '--agent',
      'data',
      '--store',
      'file',
    ]);

    assert.deepEqual(calls.credentialValidate, [{ agentId: 'tanaabot', storeId: 'file' }]);
    assert.deepEqual(calls.agent, ['data']);
  });

  it('should delegate removal from an explicit credential store', async () => {
    const { calls, program } = createProgram();

    await program.parseAsync([
      'node',
      'openclaw',
      'as',
      'credentials',
      'unset',
      'op',
      '--store',
      'file',
    ]);

    assert.deepEqual(calls.credentialUnset, [{ agentId: 'tanaabot', storeId: 'file' }]);
  });
});
