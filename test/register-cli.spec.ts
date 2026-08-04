import assert from 'node:assert/strict';

import { Command } from 'commander';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import registerAgentSystemCli from '../lib/register-cli.ts';

const validResult: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot', name: 'Tanaabot' } },
  diagnostics: [],
};

function createProgram() {
  const output = { error: [] as string[], write: [] as string[] };
  const calls = {
    agent: [] as string[],
    install: [] as Array<{ manifest: unknown; workspaceDir: string }>,
    workspace: [] as string[],
  };
  const program = new Command();
  program.name('openclaw').exitOverride();
  registerAgentSystemCli(program, {
    cwd: () => '/current',
    installService: {
      async install(input) {
        calls.install.push(input);
        return { actions: [], agentId: 'tanaabot', workspaceDir: '/workspace' };
      },
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
    output: {
      error: (message) => output.error.push(message),
      write: (message) => output.write.push(message),
    },
  });
  return { calls, output, program };
}

describe('lib/register-cli', () => {
  it('should register agent-system with the as alias and owned subcommands', () => {
    const command = createProgram().program.commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
    assert.deepEqual(
      command?.commands.map((subcommand) => subcommand.name()),
      ['validate', 'install'],
    );
  });

  it('should show command help when invoked without a subcommand', async () => {
    const { output, program } = createProgram();

    await program.parseAsync(['node', 'openclaw', 'agent-system']);

    assert.equal(output.write.join('').includes('validate'), true);
    assert.equal(output.write.join('').includes('install'), true);
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
});
