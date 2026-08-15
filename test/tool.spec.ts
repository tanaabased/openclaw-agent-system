import assert from 'node:assert/strict';

import runAgentSystemTool from '../cli/tool.ts';

describe('cli/tool', () => {
  it('should use an opaque active-agent binding for descendant command shims', async () => {
    const scopes: unknown[] = [];

    await runAgentSystemTool({
      argv: ['api', 'user'],
      command: 'gh',
      logger: { error() {}, info() {}, warn() {} },
      output: { writeStderr() {}, writeStdout() {} },
      async resolveCommandBinding() {
        return {
          admittedWorkingDirectories: ['/workspace/data', '/repos/canon'],
          agentId: 'data',
          workingDirectory: '/repos/canon',
        };
      },
      setExitCode() {},
      toolRegistry: {
        async invoke(_command, _runtime, _argv, scope) {
          scopes.push(scope);
          return {
            auditId: 'audit-id',
            kind: 'cli' as const,
            commandResult: {
              exitCode: 0,
              stderr: '',
              stdout: '',
              timedOut: false,
              truncated: false,
            },
            operation: { action: 'github.cli.invoke', risk: 'read' as const, summary: 'Read.' },
            output: {},
          };
        },
      },
      toolRuntime: {} as never,
      workspaceDir: '/repos/canon',
    });

    assert.deepEqual(scopes, [
      {
        admittedWorkingDirectories: ['/workspace/data', '/repos/canon'],
        agentId: 'data',
        source: 'agent-command',
        workspaceDir: '/repos/canon',
      },
    ]);
  });

  it('should reject an explicit agent selector when an active-agent binding exists', async () => {
    const exitCodes: number[] = [];
    const errors: string[] = [];

    await runAgentSystemTool({
      agentId: 'emori',
      argv: ['status'],
      command: 'git',
      logger: { error: (message) => errors.push(message), info() {}, warn() {} },
      output: { writeStderr() {}, writeStdout() {} },
      async resolveCommandBinding() {
        return {
          admittedWorkingDirectories: ['/workspace/data'],
          agentId: 'data',
          workingDirectory: '/workspace/data',
        };
      },
      setExitCode: (code) => exitCodes.push(code),
      toolRegistry: {
        async invoke() {
          throw new Error('the tool must not be invoked');
        },
      },
      toolRuntime: {} as never,
      workspaceDir: '/workspace/data',
    });

    assert.deepEqual(exitCodes, [1]);
    assert.equal(
      errors.some((message) => message.includes('invalid_arguments')),
      true,
    );
  });

  it('should preserve child output streams and a nonzero exit code', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];

    await runAgentSystemTool({
      argv: ['repo', 'view', 'missing/repo'],
      command: 'gh',
      logger: { error() {}, info() {}, warn() {} },
      output: {
        writeStderr: (value) => stderr.push(value),
        writeStdout: (value) => stdout.push(value),
      },
      setExitCode: (code) => exitCodes.push(code),
      toolRegistry: {
        async invoke() {
          return {
            auditId: 'audit-id',
            kind: 'cli' as const,
            commandResult: {
              exitCode: 4,
              stderr: 'not found\n',
              stdout: 'partial\n',
              timedOut: false,
              truncated: false,
            },
            operation: {
              action: 'github.cli.invoke',
              risk: 'unknown',
              summary: 'Run gh repo',
            },
            output: {},
          };
        },
      },
      toolRuntime: {} as never,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(stdout, ['partial\n']);
    assert.deepEqual(stderr, ['not found\n']);
    assert.deepEqual(exitCodes, [4]);
  });

  it('should serialize semantic output for command invocation', async () => {
    const stdout: string[] = [];

    await runAgentSystemTool({
      argv: ['list'],
      command: 'worktree',
      logger: { error() {}, info() {}, warn() {} },
      output: { writeStderr() {}, writeStdout: (value) => stdout.push(value) },
      setExitCode() {},
      toolRegistry: {
        async invoke() {
          return {
            auditId: 'audit-id',
            kind: 'semantic' as const,
            operation: {
              action: 'git.worktree.list',
              risk: 'read' as const,
              summary: 'List managed worktrees.',
            },
            output: [{ id: 'task-1', status: 'active' }],
          };
        },
      },
      toolRuntime: {} as never,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(stdout, ['[\n  {\n    "id": "task-1",\n    "status": "active"\n  }\n]\n']);
  });
});
