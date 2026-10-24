import assert from 'node:assert/strict';

import AgentSystemToolError from '../api/error.ts';
import executeAgentSystemCliTool from '../api/cli-execution.ts';
import type { AgentSystemCliRunRequest } from '../api/types.ts';
import {
  createToolTestDefinition,
  toolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

function execute(
  definition: ReturnType<typeof createToolTestDefinition>,
  runCli: (request: AgentSystemCliRunRequest) => Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    truncated: boolean;
  }>,
  signal?: AbortSignal,
  budget: { deadline?: number; now?: () => number } = {},
) {
  return executeAgentSystemCliTool({
    baseEnvironment: { PATH: '/usr/bin', SHOULD_NOT_INHERIT: 'host-private' },
    context: {
      agentId: 'data',
      manifest: toolTestManifest,
      resolvedConfiguration: { token: 'AGENT_TOKEN' },
      values: { AGENT_TOKEN: 'private-token' },
      workspaceDir: toolTestWorkspaceDir,
    },
    definition,
    input: { argument: 'status' },
    runCli,
    scope: {
      source: 'command',
      workspaceDir: toolTestWorkspaceDir,
      ...(budget.deadline === undefined ? {} : { executionDeadline: budget.deadline }),
    },
    ...(budget.now ? { now: budget.now } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe('api/cli-execution', () => {
  it('should isolate the child environment and redact invocation-scoped resources', async () => {
    const events: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
          environment: { SSH_AUTH_SOCK: '/private/socket' },
          sensitiveValues: ['lease-secret'],
        };
      },
    });

    const result = await execute(definition, async (request) => {
      requests.push(request);
      events.push('run');
      return {
        exitCode: 0,
        stderr: 'lease-secret on stderr',
        stdout: 'lease-secret on stdout',
        timedOut: false,
        truncated: false,
      };
    });

    assert.equal(result.kind, 'cli');
    assert.equal(result.commandResult.stderr, '[REDACTED] on stderr');
    assert.equal(result.commandResult.stdout, '[REDACTED] on stdout');
    assert.equal(result.output, '[REDACTED] on stdout');
    assert.equal(requests[0]?.environment.TOOL_TOKEN, 'private-token');
    assert.equal(requests[0]?.environment.SSH_AUTH_SOCK, '/private/socket');
    assert.equal(requests[0]?.environment.PATH, '/usr/bin');
    assert.equal(requests[0]?.environment.SHOULD_NOT_INHERIT, undefined);
    assert.deepEqual(events, ['acquire', 'run', 'dispose']);
  });

  it('should dispose resources when preflight validation fails', async () => {
    const events: string[] = [];
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });
    definition.runner.preflight = () => ({
      argv: ['identity'],
      validate() {
        throw new AgentSystemToolError('tool_identity_mismatch', 'The identity did not match.');
      },
    });

    await assert.rejects(
      execute(definition, async () => {
        events.push('run');
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'unexpected',
          timedOut: false,
          truncated: false,
        };
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_identity_mismatch',
    );
    assert.deepEqual(events, ['acquire', 'run', 'dispose']);
  });

  it('should return a stable error and dispose resources when execution is unavailable', async () => {
    const events: string[] = [];
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });

    await assert.rejects(
      execute(definition, async () => {
        events.push('run');
        throw new Error('runner exposed private-token');
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.code === 'tool_unavailable' &&
        error.message === 'The test-tool tool executable is unavailable.',
    );
    assert.deepEqual(events, ['acquire', 'run', 'dispose']);
  });
});

describe('managed command deadline ownership', () => {
  it('should propagate a longer caller budget and subtract identity preparation time', async () => {
    let now = 0;
    const budgets: number[] = [];
    const definition = createToolTestDefinition();
    definition.runner.preflight = () => ({ argv: ['identity'], validate() {} });
    await execute(
      definition,
      async (request) => {
        budgets.push(request.timeoutMs);
        now += 25_000;
        return { exitCode: 0, stderr: '', stdout: '', timedOut: false, truncated: false };
      },
      undefined,
      { deadline: 900_000, now: () => now },
    );
    assert.deepEqual(budgets, [30_000, 875_000]);
  });

  it('should stop before execution and dispose resources when preparation uses the caller budget', async () => {
    let now = 0;
    let disposed = false;
    let calls = 0;
    const definition = createToolTestDefinition({
      acquireResources: () => ({
        async dispose() {
          disposed = true;
        },
      }),
    });
    definition.runner.preflight = () => ({ argv: ['identity'], validate() {} });
    await assert.rejects(
      execute(
        definition,
        async () => {
          calls++;
          now = 10_000;
          return { exitCode: 0, stderr: '', stdout: '', timedOut: false, truncated: false };
        },
        undefined,
        { deadline: 10_000, now: () => now },
      ),
      { code: 'execution_timed_out' },
    );
    assert.equal(calls, 1);
    assert.equal(disposed, true);
  });
});
