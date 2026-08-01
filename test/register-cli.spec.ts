import assert from 'node:assert/strict';

import { Command } from 'commander';

import registerAgentSystemCli from '../lib/register-cli.ts';

function createProgram(output: string[]): Command {
  const program = new Command();
  program.name('openclaw').exitOverride();
  registerAgentSystemCli(program, {
    output: {
      write(message) {
        output.push(message);
      },
    },
  });
  return program;
}

describe('lib/register-cli', () => {
  it('should register agent-system with the as alias', () => {
    const command = createProgram([]).commands[0];

    assert.equal(command?.name(), 'agent-system');
    assert.deepEqual(command?.aliases(), ['as']);
  });

  it('should run the canonical command', async () => {
    const output: string[] = [];

    await createProgram(output).parseAsync(['node', 'openclaw', 'agent-system']);

    assert.deepEqual(output, ['Agent System for OpenClaw is installed.\n']);
  });

  it('should run the alias through the same command', async () => {
    const output: string[] = [];

    await createProgram(output).parseAsync(['node', 'openclaw', 'as']);

    assert.deepEqual(output, ['Agent System for OpenClaw is installed.\n']);
  });
});
