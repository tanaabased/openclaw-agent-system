import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import type { AgentCommandContext } from '../agent/command-authority.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import loadBoundToolManifest from '../api/manifest-binding.ts';
import runAgentSystemTool, { type RunAgentSystemToolOptions } from '../cli/tool.ts';
import { loadedToolTestManifest } from './tool-test-fixture.ts';

describe('cli/tool contextual routing', () => {
  function fixture(
    context: AgentCommandContext,
    manifest: AgentManifestLoadResult = {
      status: 'unmanaged',
      scope: { workspaceDir: '/host' },
      diagnostics: [],
    },
  ) {
    const calls: string[] = [];
    const options: RunAgentSystemToolOptions = {
      invocationMode: 'contextual',
      manifestService: {
        async loadForCommandDirectory() {
          return manifest;
        },
      },
      argv: ['--version'],
      command: 'git',
      workspaceDir: '/host',
      input: new Readable({
        read() {
          throw new Error('host stdin must remain unread');
        },
      }),
      output: { writeStdout() {}, writeStderr() {} },
      setExitCode(code) {
        calls.push(`exit:${code}`);
      },
      async resolveCommandContext() {
        return context;
      },
      async runHostCommand(executable) {
        calls.push(`host:${executable}`);
      },
      toolRegistry: {
        hostFallback(command) {
          return ['git', 'gh'].includes(command) ? command : undefined;
        },
        async invoke() {
          calls.push('managed');
          throw new Error('managed denial');
        },
      },
      toolRuntime: {} as never,
    };
    return { calls, options };
  }

  for (const command of ['git', 'gh']) {
    it(`should preserve workspace discovery for ${command} without session authority`, async () => {
      const manifest = loadedToolTestManifest();
      const { calls, options } = fixture({ status: 'unbound' }, manifest);
      const workspaceDir = `${manifest.scope.workspaceDir}/nested/repository`;
      await runAgentSystemTool({
        ...options,
        command,
        workspaceDir,
        input: Readable.from([]),
        toolRegistry: {
          ...options.toolRegistry,
          async invoke(_command, _runtime, _argv, scope) {
            assert.deepEqual(scope, { source: 'command', workspaceDir });
            const bound = await loadBoundToolManifest(
              { ...options.manifestService, loadForAgentId: async () => manifest },
              scope,
            );
            calls.push(`managed:${bound.manifest.agent.id}`);
            return {
              kind: 'semantic',
              output: {},
              auditId: 'audit',
              operation: { action: 'inspect', risk: 'read', summary: 'Inspect.' },
            };
          },
        },
      });
      assert.deepEqual(calls, ['managed:data']);
    });
  }

  for (const manifest of [
    loadedToolTestManifest(),
    {
      status: 'invalid',
      scope: { workspaceDir: '/agent' },
      diagnostics: [],
    } satisfies AgentManifestLoadResult,
    { status: 'unresolved', diagnostics: [] } satisfies AgentManifestLoadResult,
  ]) {
    it(`should never fall back after workspace discovery returns ${manifest.status}`, async () => {
      const { calls, options } = fixture({ status: 'unbound' }, manifest);
      await runAgentSystemTool({ ...options, input: Readable.from([]) });
      assert.deepEqual(calls, ['managed', 'exit:1']);
    });
  }

  for (const status of ['unbound', 'outside-agent-scope'] as const) {
    for (const command of ['git', 'gh']) {
      it(`should hand off ${command} in ${status} context before reading stdin`, async () => {
        const { calls, options } = fixture({ status, admittedWorkingDirectories: ['/agent'] });
        await runAgentSystemTool({ ...options, command });
        assert.deepEqual(calls, [`host:${command}`]);
      });
    }
  }
  it('should deny unregistered fallback, invalid authority, and explicit agent selection', async () => {
    const base = fixture({ status: 'unbound' });
    for (const override of [
      { command: 'worktree' },
      { command: 'missing' },
      { agentId: 'other' },
      {
        resolveCommandContext: async () => {
          throw new Error('invalid authority');
        },
      },
    ]) {
      base.calls.length = 0;
      await runAgentSystemTool({ ...base.options, ...override });
      assert.deepEqual(base.calls, ['exit:1']);
    }
  });
  it('should never retry a managed failure using host credentials', async () => {
    const { calls, options } = fixture({
      status: 'managed',
      binding: {
        agentId: 'agent',
        workingDirectory: '/agent',
        admittedWorkingDirectories: ['/agent'],
      },
    });
    await runAgentSystemTool({ ...options, input: Readable.from([]) });
    assert.deepEqual(calls, ['managed', 'exit:1']);
  });
  it('should reject strict launchers without binding or with invalid authority', async () => {
    for (const resolveCommandBinding of [
      async () => undefined,
      async () => {
        throw new Error('outside');
      },
    ]) {
      const { calls, options } = fixture({ status: 'unbound' });
      await runAgentSystemTool({
        ...options,
        invocationMode: 'managed',
        resolveCommandBinding,
      });
      assert.deepEqual(calls, ['exit:1']);
    }
  });
});
