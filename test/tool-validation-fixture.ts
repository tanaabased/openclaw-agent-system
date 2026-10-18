import assert from 'node:assert/strict';

import type {
  OpenClawPluginToolFactory,
  PluginTrustedToolPolicyRegistration,
} from 'openclaw/plugin-sdk/plugin-entry';

import AgentSystemToolError from '../api/error.ts';
import AgentSystemToolRuntime from '../api/runtime.ts';
import type { RegisteredAgentSystemTool } from '../api/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { loadedToolTestManifest, toolTestWorkspaceDir } from './tool-test-fixture.ts';

export async function assertValidationParity(
  registered: RegisteredAgentSystemTool,
  manifest: AgentManifest,
  cases: Array<{ argv: string[]; cwd?: string; signals: RegExp[] }>,
): Promise<void> {
  const logs: string[] = [];
  const unexpected = () => assert.fail('validation must reject before external activity');
  const manifestService = {
    async loadForAgentId() {
      return loadedToolTestManifest(manifest);
    },
    async loadForCommandDirectory() {
      return loadedToolTestManifest(manifest);
    },
  };
  const runtime = new AgentSystemToolRuntime({
    baseEnvironment: { PATH: '/usr/bin' },
    environmentService: { loadForAgentId: async () => unexpected() },
    logger: { error: (message) => logs.push(message), info: (message) => logs.push(message) },
    manifestService,
    resolveExecutable: async () => unexpected(),
    runCli: async () => unexpected(),
  });
  let policy: PluginTrustedToolPolicyRegistration | undefined;
  registered.registerTrustedPolicy?.(
    {
      registerTrustedToolPolicy(value) {
        policy = value;
      },
    },
    manifestService,
  );
  let factory: OpenClawPluginToolFactory | undefined;
  registered.registerTools(
    {
      registerTool(value: unknown) {
        factory = value as OpenClawPluginToolFactory;
      },
    } as never,
    runtime,
  );
  const produced = factory?.({
    agentId: manifest.agent.id,
    workspaceDir: toolTestWorkspaceDir,
  } as never);
  const tool = Array.isArray(produced) ? produced[0] : produced;
  assert.ok(policy);
  assert.ok(tool);
  for (const { argv, cwd, signals } of cases) {
    const input = {
      argv,
      stdin: 'private-stdin-sentinel op://private-vault/item/field',
      ...(cwd === undefined ? {} : { cwd }),
    };
    const decision = await policy.evaluate(
      { toolName: tool.name, params: input },
      { agentId: manifest.agent.id, toolName: tool.name },
    );
    assert.ok(decision && 'allow' in decision && decision.allow === false && decision.reason);
    for (const signal of signals) assert.match(decision.reason, signal);
    assert.doesNotMatch(decision.reason, /private-|op:\/\//u);
    const rejected = (error: unknown) => {
      assert.ok(error instanceof AgentSystemToolError);
      assert.equal(error.code, 'invalid_arguments');
      assert.equal(error.message, decision.reason);
      return true;
    };
    await assert.rejects(tool.execute('validation-call', input, undefined, undefined), rejected);
    // command input has no cwd parameter; relative cwd validation belongs to the native input.
    if (cwd === undefined) {
      await assert.rejects(
        registered.invoke(
          runtime,
          argv,
          { source: 'command', workspaceDir: toolTestWorkspaceDir },
          input.stdin,
        ),
        rejected,
      );
    }
  }
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every(
      (line) => line.includes('stage="validation"') && line.includes('code="invalid_arguments"'),
    ),
  );
  assert.doesNotMatch(logs.join('\n'), /private-|op:\/\/|agent\.yaml|stack|cause/u);
}
