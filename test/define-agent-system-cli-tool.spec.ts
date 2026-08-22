import assert from 'node:assert/strict';

import type {
  OpenClawPluginToolFactory,
  PluginTrustedToolPolicyRegistration,
} from 'openclaw/plugin-sdk/plugin-entry';

import defineAgentSystemCliTool from '../api/define-cli-tool.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';
import {
  createToolTestDefinition,
  loadedToolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

describe('api/define-cli-tool', () => {
  it('should compile command and native tool calls through one runtime definition', async () => {
    const definition = createToolTestDefinition();
    const registered = defineAgentSystemCliTool(definition);
    const calls: Array<{ input: unknown; scope: unknown; signal?: AbortSignal }> = [];
    const runtime = {
      async executeCli(
        receivedDefinition: unknown,
        input: unknown,
        scope: unknown,
        signal?: AbortSignal,
      ) {
        assert.equal(receivedDefinition, definition);
        calls.push({ input, scope, ...(signal ? { signal } : {}) });
        return {
          auditId: 'audit-id',
          kind: 'cli' as const,
          commandResult: {
            exitCode: 0,
            stderr: '',
            stdout: 'ok\n',
            timedOut: false,
            truncated: false,
          },
          operation: { action: 'inspect', risk: 'read', summary: 'Inspect test data.' },
          output: 'ok\n',
        };
      },
    } as AgentSystemToolRuntime;

    await registered.invoke(runtime, ['command'], {
      source: 'command',
      workspaceDir: toolTestWorkspaceDir,
    });

    let factory: OpenClawPluginToolFactory | undefined;
    registered.registerTools(
      {
        registerTool(tool: unknown) {
          factory = tool as OpenClawPluginToolFactory;
        },
      } as never,
      runtime,
    );
    const toolContext = { agentId: 'data', workspaceDir: toolTestWorkspaceDir } as never;
    const produced = factory?.(toolContext);
    const tool = Array.isArray(produced) ? produced[0] : produced;
    assert.ok(tool);
    const signal = new AbortController().signal;
    const result = await tool.execute('native-call', { argument: 'native' }, signal, undefined);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: '"ok\\n"' }],
      details: { auditId: 'audit-id', output: 'ok\n' },
    });
    assert.deepEqual(calls, [
      {
        input: { argument: 'command' },
        scope: { source: 'command', workspaceDir: toolTestWorkspaceDir },
      },
      {
        input: { argument: 'native' },
        scope: { source: 'tool', toolCallId: 'native-call', toolContext },
        signal,
      },
    ]);
  });

  it('should fail closed before evaluating policy without trusted context and input', async () => {
    let policy: PluginTrustedToolPolicyRegistration | undefined;
    let authorizationCalls = 0;
    const registered = defineAgentSystemCliTool(
      createToolTestDefinition({
        authorize() {
          authorizationCalls += 1;
          return { status: 'allowed' };
        },
      }),
    );
    registered.registerTrustedPolicy?.(
      {
        registerTrustedToolPolicy(registration) {
          policy = registration;
        },
      },
      {
        async loadForAgentId() {
          return loadedToolTestManifest();
        },
      },
    );
    assert.ok(policy);

    assert.deepEqual(
      await policy.evaluate(
        { params: { argument: 'status' }, toolName: 'agent_system_test_tool' },
        { toolName: 'agent_system_test_tool' },
      ),
      { allow: false, reason: 'Agent System could not resolve the active agent.' },
    );
    assert.deepEqual(
      await policy.evaluate(
        { params: { argument: '' }, toolName: 'agent_system_test_tool' },
        { agentId: 'data', toolName: 'agent_system_test_tool' },
      ),
      { allow: false, reason: 'The agent_system_test_tool request is invalid.' },
    );
    assert.equal(authorizationCalls, 0);
  });

  it('should preserve allowed and denied decisions through trusted policy', async () => {
    let allowed = false;
    let policy: PluginTrustedToolPolicyRegistration | undefined;
    defineAgentSystemCliTool(
      createToolTestDefinition({
        authorize: () =>
          allowed
            ? { status: 'allowed' }
            : { status: 'denied', reason: 'Test policy denied this operation.' },
      }),
    ).registerTrustedPolicy?.(
      {
        registerTrustedToolPolicy(registration) {
          policy = registration;
        },
      },
      {
        async loadForAgentId() {
          return loadedToolTestManifest();
        },
      },
    );
    assert.ok(policy);
    const event = {
      params: { argument: 'delete' },
      toolCallId: 'approved-call',
      toolName: 'agent_system_test_tool',
    };
    const context = {
      agentId: 'data',
      toolCallId: 'approved-call',
      toolName: 'agent_system_test_tool',
    };

    assert.deepEqual(await policy.evaluate(event, context), {
      allow: false,
      reason: 'Test policy denied this operation.',
    });
    allowed = true;
    assert.equal(await policy.evaluate(event, context), undefined);
  });
});
