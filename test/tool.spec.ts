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
});
