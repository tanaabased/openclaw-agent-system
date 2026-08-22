import assert from 'node:assert/strict';

import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';

import defineAgentSystemSemanticTool from '../api/define-semantic-tool.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';
import { createSemanticToolTestDefinition } from './tool-test-fixture.ts';

describe('api/define-semantic-tool', () => {
  it('should register native and command semantic surfaces through the shared runtime', async () => {
    const definition = createSemanticToolTestDefinition();
    const registered = defineAgentSystemSemanticTool(definition);
    const calls: Array<{ input: unknown; scope: unknown }> = [];
    const runtime = {
      async executeSemantic(received: unknown, input: unknown, scope: unknown) {
        assert.equal(received, definition);
        calls.push({ input, scope });
        return {
          auditId: 'audit-id',
          kind: 'semantic' as const,
          operation: { action: 'inspect', risk: 'read', summary: 'Inspect test data.' },
          output: 'semantic-result',
        };
      },
    } as AgentSystemToolRuntime;
    await registered.invoke(runtime, ['command'], {
      source: 'command',
      workspaceDir: '/workspace',
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
    const toolContext = {
      agentId: 'data',
      sessionKey: 'session-1',
      workspaceDir: '/workspace',
    } as never;
    const produced = factory?.(toolContext);
    const tool = Array.isArray(produced) ? produced[0] : produced;
    assert.ok(tool);

    const result = await tool.execute(
      'call-1',
      { argument: 'status' },
      new AbortController().signal,
      undefined,
    );

    assert.deepEqual(result, {
      content: [{ type: 'text', text: '"semantic-result"' }],
      details: { auditId: 'audit-id', output: 'semantic-result' },
    });
    assert.deepEqual(calls, [
      {
        input: { argument: 'command' },
        scope: { source: 'command', workspaceDir: '/workspace' },
      },
      {
        input: { argument: 'status' },
        scope: { source: 'tool', toolCallId: 'call-1', toolContext },
      },
    ]);
    assert.deepEqual(registered.commands, [{ command: 'test-semantic-tool' }]);
  });
});
