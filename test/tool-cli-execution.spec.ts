import assert from 'node:assert/strict';

import AgentSystemToolError from '../lib/tool-error.ts';
import executeAgentSystemCliTool from '../lib/tool-cli-execution.ts';
import type { AgentSystemCliRunRequest } from '../lib/tool-types.ts';
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
    scope: { source: 'command', workspaceDir: toolTestWorkspaceDir },
    ...(signal === undefined ? {} : { signal }),
  });
}

describe('lib/tool-cli-execution', () => {
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
