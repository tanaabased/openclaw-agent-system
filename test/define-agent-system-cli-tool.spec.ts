import assert from 'node:assert/strict';

import type {
  OpenClawPluginToolFactory,
  PluginTrustedToolPolicyRegistration,
} from 'openclaw/plugin-sdk/plugin-entry';

import defineAgentSystemCliTool from '../lib/define-agent-system-cli-tool.ts';
import type AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentSystemAuthorizationDecision } from '../lib/tool-types.ts';
import {
  createToolTestDefinition,
  loadedToolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

describe('lib/define-agent-system-cli-tool', () => {
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
      { record() {} },
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

  it('should issue and record only an exact allow-once approval receipt', async () => {
    let decision: AgentSystemAuthorizationDecision = {
      status: 'denied',
      reason: 'Test policy denied this operation.',
    };
    const receipts: unknown[] = [];
    let policy: PluginTrustedToolPolicyRegistration | undefined;
    defineAgentSystemCliTool(
      createToolTestDefinition({ authorize: () => decision }),
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
      { record: (receipt) => receipts.push(receipt) },
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
    decision = {
      status: 'approval_required',
      reason: 'Test policy requires approval.',
      request: { description: 'Delete test data.', severity: 'critical', title: 'Delete data' },
    };
    const result = await policy.evaluate(event, context);
    assert.ok(result && 'requireApproval' in result && result.requireApproval);
    assert.deepEqual(result.requireApproval.allowedDecisions, ['allow-once', 'deny']);

    await result.requireApproval.onResolution?.('deny');
    await result.requireApproval.onResolution?.('allow-always');
    assert.deepEqual(receipts, []);
    await result.requireApproval.onResolution?.('allow-once');
    assert.deepEqual(receipts, [
      {
        agentId: 'data',
        input: { argument: 'delete' },
        toolCallId: 'approved-call',
        toolId: 'test-tool',
      },
    ]);
  });
});
