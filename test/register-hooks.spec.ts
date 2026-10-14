import assert from 'node:assert/strict';

import type AgentManifestService from '../manifest/service.ts';

import { normalizeAgentSetup } from '../manifest/setup-schema.ts';

import { agentCommandSecurityGuidance } from '../agent/command-security.ts';
import registerAgentSystemHooks from '../core/register-hooks.ts';

describe('core/register-hooks', () => {
  it('should pass the currently loaded manifest to both prompt lifecycle callbacks', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const manifests: unknown[] = [];
    let result: Awaited<ReturnType<AgentManifestService['loadForRuntimeContext']>> = {
      status: 'loaded',
      scope: { agentId: 'data', workspaceDir: '/workspace' },
      path: '/workspace/agent.yaml',
      digest: 'digest',
      diagnostics: [],
      validationChecks: [],
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        github: {
          notifications: {
            schemaVersion: 2,
            runtimes: ['openclaw'],
            intervalMinutes: 5,
            maxConcurrentItems: 1,
            allowedRepositoryOwners: [{ login: 'example', nodeId: 'O_example' }],
          },
        },
      },
    };
    const loaded = result.manifest;
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return result;
        },
      },
      { guidance: () => [] },
      {
        async beforeRun(_context, manifest) {
          manifests.push(manifest);
          return undefined;
        },
        instructions(_context, manifest) {
          manifests.push(manifest);
          return undefined;
        },
      },
    );
    for (const name of ['before_prompt_build', 'before_agent_run'])
      await handlers.get(name)!({}, { agentId: 'data' });
    result = { status: 'unresolved', diagnostics: [] };
    for (const name of ['before_prompt_build', 'before_agent_run'])
      await handlers.get(name)!({}, { agentId: 'data' });
    assert.deepEqual(manifests, [loaded, loaded, undefined, undefined]);
  });

  it('should load manifest metadata for lifecycle and prompt hooks', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const calls: Array<{ agentId?: string; trigger: string }> = [];
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext(context, trigger) {
          calls.push({ agentId: context.agentId, trigger });
          return { status: 'unresolved', diagnostics: [] };
        },
      },
      { guidance: () => [] },
    );

    await handlers.get('session_start')?.({}, { agentId: 'tanaabot', sessionId: 'one' });
    await handlers.get('before_prompt_build')?.({}, { agentId: 'tanaabot', sessionId: 'one' });

    assert.deepEqual([...handlers.keys()], ['session_start', 'before_prompt_build']);
    assert.deepEqual(calls, [
      { agentId: 'tanaabot', trigger: 'session_start' },
      { agentId: 'tanaabot', trigger: 'before_prompt_build' },
    ]);
  });

  it('should append central and configured tool guidance without setup command text', async () => {
    const normalized = normalizeAgentSetup('echo private-setup-command');
    assert.equal(normalized.status, 'valid');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return {
            status: 'loaded',
            scope: { agentId: 'data', workspaceDir: '/workspace' },
            path: '/workspace/agent.yaml',
            digest: 'digest',
            manifest: { schemaVersion: 1, agent: { id: 'data' }, setup: normalized.setup },
            diagnostics: [],
            validationChecks: [],
          } as const;
        },
      },
      { guidance: () => ['Prefer the configured Agent System tool.'] },
    );

    const result = await handlers.get('before_prompt_build')?.(
      {},
      { agentId: 'data', sessionId: 'one' },
    );

    assert.deepEqual(result, {
      appendSystemContext: `${agentCommandSecurityGuidance}\n\nPrefer the configured Agent System tool.`,
    });
  });

  it('should append channel guidance through the prompt hook', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return { status: 'unresolved', diagnostics: [] } as const;
        },
      },
      { guidance: () => [] },
      {
        async instructions(context) {
          return context.messageProvider === 'agent-system-github'
            ? 'Current GitHub turn instructions.'
            : undefined;
        },
      },
    );

    const result = await handlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'agent-system-github', sessionId: 'one' },
    );

    assert.deepEqual(result, {
      appendSystemContext: 'Current GitHub turn instructions.',
    });
  });
});
