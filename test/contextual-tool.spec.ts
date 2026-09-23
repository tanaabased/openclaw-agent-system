import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import type { AgentCommandContext } from '../agent/command-authority.ts';
import runAgentSystemTool, { type RunAgentSystemToolOptions } from '../cli/tool.ts';

describe('cli/tool contextual routing', () => {
  function fixture(context: AgentCommandContext) {
    const calls: string[] = [];
    const options: RunAgentSystemToolOptions = {
      invocationMode: 'contextual',
      argv: ['--version'],
      command: 'git',
      workspaceDir: '/host',
      input: new Readable({
        read() {
          throw new Error('host stdin must remain unread');
        },
      }),
      output: { writeStdout() {}, writeStderr() {} },
      setExitCode(code) {
        calls.push(`exit:${code}`);
      },
      async resolveCommandContext() {
        return context;
      },
      async runHostCommand(executable) {
        calls.push(`host:${executable}`);
      },
      toolRegistry: {
        hostFallback(command) {
          return ['git', 'gh'].includes(command) ? command : undefined;
        },
        async invoke() {
          calls.push('managed');
          throw new Error('managed denial');
        },
      },
      toolRuntime: {} as never,
    };
    return { calls, options };
  }

  for (const status of ['unbound', 'outside-agent-scope'] as const) {
    for (const command of ['git', 'gh']) {
      it(`should hand off ${command} in ${status} context before reading stdin`, async () => {
        const { calls, options } = fixture({ status, admittedWorkingDirectories: ['/agent'] });
        await runAgentSystemTool({ ...options, command });
        assert.deepEqual(calls, [`host:${command}`]);
      });
    }
  }
  it('should deny unregistered fallback, invalid authority, and explicit agent selection', async () => {
    const base = fixture({ status: 'unbound' });
    for (const override of [
      { command: 'worktree' },
      { command: 'missing' },
      { agentId: 'other' },
      {
        resolveCommandContext: async () => {
          throw new Error('invalid authority');
        },
      },
    ]) {
      base.calls.length = 0;
      await runAgentSystemTool({ ...base.options, ...override });
      assert.deepEqual(base.calls, ['exit:1']);
    }
  });
  it('should never retry a managed failure using host credentials', async () => {
    const { calls, options } = fixture({
      status: 'managed',
      binding: {
        agentId: 'agent',
        workingDirectory: '/agent',
        admittedWorkingDirectories: ['/agent'],
      },
    });
    await runAgentSystemTool({ ...options, input: Readable.from([]) });
    assert.deepEqual(calls, ['managed', 'exit:1']);
  });
  it('should reject strict launchers without binding or with invalid authority', async () => {
    for (const resolveCommandBinding of [
      async () => undefined,
      async () => {
        throw new Error('outside');
      },
    ]) {
      const { calls, options } = fixture({ status: 'unbound' });
      await runAgentSystemTool({
        ...options,
        invocationMode: 'managed',
        resolveCommandBinding,
      });
      assert.deepEqual(calls, ['exit:1']);
    }
  });
});
