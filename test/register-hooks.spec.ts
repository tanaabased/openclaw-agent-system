import assert from 'node:assert/strict';

import { normalizeAgentSetup } from '../manifest/setup-schema.ts';

import { agentCommandSecurityGuidance } from '../agent/command-security.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import openclawTurnContext from '../agent/openclaw-turn-context.ts';
import registerAgentSystemHooks from '../core/register-hooks.ts';

describe('core/register-hooks', () => {
  it('should supply private context for native runs without an optional current message id', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const record = {
      id: 'a'.repeat(64),
      threadId: 'agent:data:dashboard:issue',
      context: '{"body":"PRIVATE-GITHUB-FACT"}',
      request: { key: 'agent:data:dashboard:issue', agentId: 'data' },
      sessionCreation: { verified: true, sessionId: 'one' },
      assessmentTurn: { runId: 'assessment' },
    } as OpenClawDispatchRecord;
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
            manifest: { schemaVersion: 1, agent: { id: 'data' } },
            diagnostics: [],
            validationChecks: [],
          } as const;
        },
      },
      { guidance: () => [] },
      async (_manifest, _workspace, binding) => openclawTurnContext(record, binding),
    );
    const hook = handlers.get('before_prompt_build')!;
    const binding = {
      agentId: 'data',
      sessionKey: record.threadId,
      sessionId: 'one',
      runId: 'assessment',
    };
    const event = { prompt: 'Assess the issue.', messages: [] };
    for (const currentUserMessageId of [undefined, 'native-input']) {
      const output = (await hook({ ...event, currentUserMessageId }, binding)) as {
        appendContext: string;
        appendSystemContext: string;
      };
      assert.match(output.appendContext, /PRIVATE-GITHUB-FACT/);
      assert.match(output.appendContext, /"runId":"assessment"/);
      assert.doesNotMatch(output.appendSystemContext, /PRIVATE-GITHUB-FACT/);
      if (currentUserMessageId) assert.match(output.appendContext, /native-input/);
      else assert.doesNotMatch(output.appendContext, /inputId/);
    }
    record.result = { outcome: 'plan-ready', plan: 'RETAINED-PLAN' } as never;
    const later = (await hook(event, { ...binding, runId: 'later' })) as {
      appendContext: string;
    };
    assert.match(later.appendContext, /RETAINED-PLAN/);
    assert.match(later.appendContext, /"runId":"later"/);
    for (const change of [
      { runId: undefined },
      { sessionKey: 'other' },
      { sessionId: 'replaced' },
      { agentId: 'other' },
    ]) {
      const output = (await hook(event, { ...binding, ...change })) as {
        appendContext?: string;
      };
      assert.equal(output.appendContext, undefined);
    }
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
});
