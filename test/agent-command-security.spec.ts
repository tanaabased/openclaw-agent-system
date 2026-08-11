import assert from 'node:assert/strict';

import registerAgentCommandSecurity from '../lib/agent-command-security.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

function loaded(agentId: string, workspaceDir: string): AgentManifestLoadResult {
  return {
    status: 'loaded',
    scope: { agentId, workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: `${agentId}-digest`,
    manifest: { schemaVersion: 1, agent: { id: agentId }, git: {} },
    diagnostics: [],
    validationChecks: [],
  };
}

function setup(
  options: {
    active?: AgentManifestLoadResult;
    commandScope?: AgentManifestLoadResult;
  } = {},
) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const logs = { error: [] as string[], warn: [] as string[] };
  const registrations: Array<{ name: string; priority?: number }> = [];
  registerAgentCommandSecurity(
    {
      on(
        name: string,
        handler: (...args: never[]) => unknown,
        hookOptions?: { priority?: number },
      ) {
        handlers.set(name, handler);
        registrations.push({ name, priority: hookOptions?.priority });
      },
    } as never,
    {
      logger: {
        error: (message) => logs.error.push(message),
        info() {},
        warn: (message) => logs.warn.push(message),
      },
      managedExecutableDirectories: ['/package/bin'],
      manifestService: {
        async loadForCommandDirectory() {
          return options.commandScope ?? loaded('tanaabot', '/workspace/tanaabot');
        },
        async loadForRuntimeContext() {
          return options.active ?? loaded('tanaabot', '/workspace/tanaabot');
        },
      },
    },
  );
  const handler = handlers.get('before_tool_call');
  if (!handler) throw new Error('before_tool_call was not registered');
  return { handler, logs, registrations };
}

function context(agentId = 'tanaabot') {
  return {
    agentId,
    runId: 'run-one',
    sessionId: 'session-one',
    toolCallId: 'tool-one',
    toolName: 'exec',
  };
}

describe('lib/agent-command-security', () => {
  it('should register a high-priority before-tool-call gate', () => {
    const { registrations } = setup();

    assert.deepEqual(registrations, [{ name: 'before_tool_call', priority: 100 }]);
  });

  it('should block a current-agent operator route with a native retry', async () => {
    const { handler, logs } = setup();
    const result = await handler(
      {
        params: {
          command: 'openclaw as tool gh --agent tanaabot -- api user secret-marker',
        },
        toolName: 'exec',
      } as never,
      context() as never,
    );

    assert.deepEqual(result, {
      block: true,
      blockReason:
        'Agent System operator commands are unavailable through agent command tools. Retry this operation with agent_system_github using the active agent context.',
    });
    assert.equal(logs.warn[0]?.includes('code="agent-operator-route-corrective"'), true);
    assert.equal(logs.warn[0]?.includes('secret-marker'), false);
  });

  it('should hard-block an explicit cross-agent identity without exposing the command', async () => {
    const { handler, logs } = setup();
    const result = await handler(
      {
        params: { command: 'openclaw agent-system tool git --agent emori -- secret-marker' },
        toolName: 'exec',
      } as never,
      context() as never,
    );

    assert.equal((result as { block?: boolean }).block, true);
    assert.equal(
      (result as { blockReason?: string }).blockReason?.includes('another agent identity'),
      true,
    );
    assert.equal(logs.error[0]?.includes('code="agent-cross-identity-blocked"'), true);
    assert.equal(logs.error[0]?.includes('targetAgentId="emori"'), true);
    assert.equal(logs.error[0]?.includes('secret-marker'), false);
  });

  it('should hard-block credential commands for the active agent', async () => {
    const { handler, logs } = setup();
    const result = await handler(
      {
        params: { command: 'openclaw agent-system credentials validate op' },
        toolName: 'exec',
      } as never,
      context() as never,
    );

    assert.equal((result as { block?: boolean }).block, true);
    assert.equal(logs.error[0]?.includes('code="agent-credentials-command-blocked"'), true);
  });

  it('should block ordinary commands started from another agent workspace', async () => {
    const { handler, logs } = setup({
      commandScope: loaded('emori', '/workspace/emori'),
    });
    const result = await handler(
      {
        params: { command: 'git status', cwd: '/workspace/emori/project' },
        toolName: 'exec',
      } as never,
      context() as never,
    );

    assert.equal((result as { block?: boolean }).block, true);
    assert.equal(logs.error[0]?.includes('code="agent-workspace-boundary-blocked"'), true);
    assert.equal(logs.error[0]?.includes('targetAgentId="emori"'), true);
  });

  it('should allow unrelated commands in the active agent workspace', async () => {
    const { handler, logs } = setup();
    const result = await handler(
      {
        params: { command: 'git status', cwd: '/workspace/tanaabot/project' },
        toolName: 'exec',
      } as never,
      context() as never,
    );

    assert.equal(result, undefined);
    assert.deepEqual(logs, { error: [], warn: [] });
  });

  it('should fail closed for operator commands without verified agent context', async () => {
    const { handler, logs } = setup({ active: { status: 'unresolved', diagnostics: [] } });
    const result = await handler(
      {
        params: { command: '/package/bin/gh api user' },
        toolName: 'exec',
      } as never,
      { toolName: 'exec' } as never,
    );

    assert.equal((result as { block?: boolean }).block, true);
    assert.equal(logs.error[0]?.includes('code="agent-command-context-unresolved"'), true);
  });
});
