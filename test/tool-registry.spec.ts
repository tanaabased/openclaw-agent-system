import assert from 'node:assert/strict';

import defineAgentSystemCliTool from '../lib/define-agent-system-cli-tool.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import AgentSystemToolRegistry from '../lib/tool-registry.ts';
import type AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { RegisteredAgentSystemTool } from '../lib/tool-types.ts';
import {
  createToolTestDefinition,
  toolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

function registeredTestTool(): RegisteredAgentSystemTool {
  return defineAgentSystemCliTool(createToolTestDefinition());
}

describe('lib/tool-registry', () => {
  it('should project owned and manifest-configured native tool names', () => {
    const configured = registeredTestTool();
    const unconfigured: RegisteredAgentSystemTool = {
      ...configured,
      commands: [{ command: 'other-tool' }],
      id: 'other-tool',
      isConfigured: () => false,
      toolNames: ['agent_system_other_tool'],
    };
    const registry = new AgentSystemToolRegistry([configured, unconfigured]);

    assert.deepEqual(registry.allToolNames(), [
      'agent_system_test_tool',
      'agent_system_other_tool',
    ]);
    assert.deepEqual(registry.configuredToolNames(toolTestManifest), ['agent_system_test_tool']);
  });

  it('should expose guidance only for configured tool definitions', () => {
    const configured = new AgentSystemToolRegistry([registeredTestTool()]);
    const unconfigured = new AgentSystemToolRegistry([
      defineAgentSystemCliTool(createToolTestDefinition({ configured: false })),
    ]);

    assert.deepEqual(configured.guidance(toolTestManifest), ['Use the Agent System test tool.']);
    assert.deepEqual(unconfigured.guidance(toolTestManifest), []);
  });

  it('should route an owned command and reject an unavailable command', async () => {
    const runtimeCalls: unknown[] = [];
    const runtime = {
      async executeCli(definition: unknown, input: unknown, scope: unknown) {
        runtimeCalls.push({ definition, input, scope });
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
    const registry = new AgentSystemToolRegistry([registeredTestTool()]);

    await registry.invoke('test-tool', runtime, ['status'], {
      source: 'command',
      workspaceDir: toolTestWorkspaceDir,
    });
    assert.equal(runtimeCalls.length, 1);
    assert.throws(
      () =>
        registry.invoke('missing', runtime, [], {
          source: 'command',
          workspaceDir: toolTestWorkspaceDir,
        }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_unavailable',
    );
  });

  it('should reject duplicate tool and command ownership', () => {
    const tool = registeredTestTool();

    assert.throws(
      () => new AgentSystemToolRegistry([tool, tool]),
      /Duplicate Agent System tool id/,
    );
    assert.throws(
      () => new AgentSystemToolRegistry([tool, { ...tool, id: 'other' }]),
      /Duplicate Agent System tool command/,
    );
  });

  it('should delegate native tools and trusted policies to every registered owner', () => {
    const calls: string[] = [];
    const base = registeredTestTool();
    const tools = ['first', 'second'].map((id): RegisteredAgentSystemTool => ({
      ...base,
      id,
      commands: [{ command: id }],
      registerTools() {
        calls.push(`tool:${id}`);
      },
      registerTrustedPolicy() {
        calls.push(`policy:${id}`);
      },
    }));
    const registry = new AgentSystemToolRegistry(tools);

    registry.registerTools({} as never, {} as AgentSystemToolRuntime);
    registry.registerTrustedPolicies({} as never, {} as never);

    assert.deepEqual(calls, ['tool:first', 'tool:second', 'policy:first', 'policy:second']);
  });
});
