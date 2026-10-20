import assert from 'node:assert/strict';

import runAgentSystemTool from '../cli/tool.ts';
import AgentSystemToolError from '../api/error.ts';
import presentCliCommand from '../cli/presentation.ts';

describe('cli/tool', () => {
  it('should present safe validation reasons on stderr while redacting unexpected failures', async () => {
    for (const failure of [
      new AgentSystemToolError(
        'invalid_arguments',
        'Use agent_system_git_worktree for managed lifecycle changes.',
      ),
      new Error('private-exception-sentinel'),
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCodes: number[] = [];
      const output = {
        writeStderr: (message: string) => stderr.push(message),
        writeStdout: (message: string) => stdout.push(message),
      };
      await presentCliCommand(runAgentSystemTool)({
        invocationMode: 'operator',
        manifestService: {
          async loadForCommandDirectory() {
            assert.fail('unexpected discovery');
          },
        },
        argv: ['worktree', 'add', 'private-argument-sentinel'],
        command: 'git',
        output,
        setExitCode: (code) => exitCodes.push(code),
        toolRegistry: {
          hostFallback: () => undefined,
          async invoke() {
            throw failure;
          },
        },
        toolRuntime: {} as never,
        workspaceDir: '/workspace/data',
      });
      assert.deepEqual(stdout, []);
      assert.deepEqual(exitCodes, [1]);
      const rendered = stderr.join('');
      assert.match(
        rendered,
        failure instanceof AgentSystemToolError ? /invalid_arguments/u : /execution_failed/u,
      );
      if (failure instanceof AgentSystemToolError)
        assert.match(rendered, /agent_system_git_worktree/u);
      assert.doesNotMatch(rendered, /private-/u);
    }
  });

  it('should use an opaque active-agent binding for descendant command shims', async () => {
    const scopes: unknown[] = [];

    await runAgentSystemTool({
      invocationMode: 'operator',
      manifestService: {
        async loadForCommandDirectory() {
          throw new Error('unexpected discovery');
        },
      },
      argv: ['api', 'user'],
      command: 'gh',
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
        hostFallback: () => undefined,
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
      invocationMode: 'operator',
      manifestService: {
        async loadForCommandDirectory() {
          throw new Error('unexpected discovery');
        },
      },
      agentId: 'emori',
      argv: ['status'],
      command: 'git',
      output: { writeStderr: (message) => errors.push(message), writeStdout() {} },
      async resolveCommandBinding() {
        return {
          admittedWorkingDirectories: ['/workspace/data'],
          agentId: 'data',
          workingDirectory: '/workspace/data',
        };
      },
      setExitCode: (code) => exitCodes.push(code),
      toolRegistry: {
        hostFallback: () => undefined,
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
      invocationMode: 'operator',
      manifestService: {
        async loadForCommandDirectory() {
          throw new Error('unexpected discovery');
        },
      },
      argv: ['repo', 'view', 'missing/repo'],
      command: 'gh',
      output: {
        writeStderr: (value) => stderr.push(value),
        writeStdout: (value) => stdout.push(value),
      },
      setExitCode: (code) => exitCodes.push(code),
      toolRegistry: {
        hostFallback: () => undefined,
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
      invocationMode: 'operator',
      manifestService: {
        async loadForCommandDirectory() {
          throw new Error('unexpected discovery');
        },
      },
      argv: ['list'],
      command: 'worktree',
      output: { writeStderr() {}, writeStdout: (value) => stdout.push(value) },
      setExitCode() {},
      toolRegistry: {
        hostFallback: () => undefined,
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
