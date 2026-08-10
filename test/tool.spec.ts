import assert from 'node:assert/strict';

import runAgentSystemTool from '../cli/tool.ts';

describe('cli/tool', () => {
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
      output: { writeStdout: (value) => stdout.push(value) },
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
