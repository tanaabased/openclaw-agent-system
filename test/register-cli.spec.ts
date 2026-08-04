import assert from 'node:assert/strict';

import { Command } from 'commander';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import registerAgentSystemCli from '../lib/register-cli.ts';

const validResult: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot' } },
  diagnostics: [],
};

function createProgram(results: {
  agent?: AgentManifestLoadResult;
  workspace?: AgentManifestLoadResult;
}) {
  const output = { error: [] as string[], write: [] as string[] };
  const calls = { agent: [] as string[], workspace: [] as string[] };
  const exitCodes: number[] = [];
  const program = new Command();
  program.name('openclaw').exitOverride();
  registerAgentSystemCli(program, {
    cwd: () => '/current',
    manifestService: {
      async loadForAgentId(agentId) {
        calls.agent.push(agentId);
        return results.agent ?? validResult;
      },
      async loadForWorkspace(workspaceDir) {
        calls.workspace.push(workspaceDir);
        return results.workspace ?? validResult;
      },
    },
    output: {
      error: (message) => output.error.push(message),
      write: (message) => output.write.push(message),
    },
    setExitCode: (code) => exitCodes.push(code),
  });
  return { calls, exitCodes, output, program };
}

describe('lib/register-cli', () => {
  it('should register agent-system with the as alias and validate subcommand', () => {
    const command = createProgram({}).program.commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
    assert.deepEqual(
      command?.commands.map((subcommand) => subcommand.name()),
      ['validate'],
    );
  });

  it('should show command help when invoked without a subcommand', async () => {
    const { output, program } = createProgram({});

    await program.parseAsync(['node', 'openclaw', 'agent-system']);

    assert.equal(output.write.join('').includes('validate'), true);
  });

  it('should validate the current workspace', async () => {
    const { calls, output, program } = createProgram({});

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'validate']);

    assert.deepEqual(calls.workspace, ['/current']);
    assert.deepEqual(output.write, [
      'valid: Agent System manifest for tanaabot at /workspace/agent.yaml\n',
    ]);
  });

  it('should validate an explicit agent through the short alias', async () => {
    const { calls, program } = createProgram({});

    await program.parseAsync(['node', 'openclaw', 'as', 'validate', '--agent', 'tanaabot']);

    assert.deepEqual(calls.agent, ['tanaabot']);
  });

  it('should report validation diagnostics to stderr and set a failing exit code', async () => {
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/current' },
      path: '/current/agent.yaml',
      diagnostics: [
        {
          code: 'manifest-schema',
          fieldPath: '/agent/id',
          message: 'Manifest value does not match the schema.',
          severity: 'error',
        },
      ],
    };
    const { exitCodes, output, program } = createProgram({ workspace: invalid });

    await program.parseAsync(['node', 'openclaw', 'agent-system', 'validate']);

    assert.deepEqual(exitCodes, [1]);
    assert.equal(output.error.join('').includes('[manifest-schema]'), true);
  });
});
