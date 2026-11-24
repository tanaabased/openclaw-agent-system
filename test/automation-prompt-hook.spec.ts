import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import registerAutomationPromptHooks from '../core/automation-prompt-hook.ts';
import {
  AutomationError,
  AutomationVerificationError,
} from '../agent/automations/automation-errors.ts';

function fixture(runtime = 'codex') {
  let configFailure = false;
  let modelRuntime: string | undefined;
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  let prompt: string | undefined = 'hidden instructions one';
  let failure: Error | undefined;
  let observationFailure = false;
  let loads = 0;
  let payloadKind = 'agentTurn';
  const logs: string[] = [];
  const context = {
    trigger: 'cron',
    modelProviderId: 'test-provider',
    modelId: 'test-model',
    runId: 'run-one',
    jobId: 'native-job',
    agentId: 'test',
    workspaceDir: '/workspace',
    sessionKey: 'agent:test:scheduled',
    sessionId: 'session',
  };
  registerAutomationPromptHooks(
    {
      on: ((name, handler) => hooks.set(name, handler as never)) as OpenClawPluginApi['on'],
      logger: {
        info() {},
        warn: (text) => logs.push(text),
        error() {},
        debug: (text) => logs.push(text),
      },
    },
    async () => {
      if (observationFailure) throw new Error('private provider diagnostic');
      return [
        {
          id: 'native-job',
          agentId: 'test',
          declarationKey: 'agent-system:scope:custom',
          payload: { kind: payloadKind },
        },
      ];
    },
    async () => {
      loads++;
      if (failure) throw failure;
      return { prompt };
    },
    (): OpenClawConfig => {
      if (configFailure) throw new Error('private config diagnostic');
      return {
        agents: {
          entries: {
            test: {
              models:
                modelRuntime === undefined
                  ? {}
                  : { 'test-provider/test-model': { agentRuntime: { id: modelRuntime } } },
            },
          },
        },
        models: {
          providers: {
            'test-provider': {
              baseUrl: 'https://example.invalid',
              models: [],
              agentRuntime: { id: runtime },
            },
          },
        },
      };
    },
  );
  return {
    context,
    logs,
    selectModelRuntime: (value: string) => {
      modelRuntime = value;
    },
    loseConfig: () => {
      configFailure = true;
    },
    events: () => logs.map((line) => JSON.parse(line.slice(line.indexOf('{')))),
    call: (hook: string, ctx: object = context, event: unknown = {}) =>
      hooks.get(hook)!(event, ctx),
    edit: (value: string | undefined) => {
      prompt = value;
    },
    fail: (error = new Error('private filesystem diagnostic')) => {
      failure = error;
    },
    loseObservation: () => {
      observationFailure = true;
    },
    command: () => {
      payloadKind = 'command';
    },
    loads: () => loads,
  };
}

describe('core/automation-prompt-hook', () => {
  it('should carry native admission into hosted codex prompt hooks without a job id or an input gate', async () => {
    const f = fixture();
    assert.equal(await f.call('before_agent_reply'), undefined);
    const context = { ...f.context, jobId: undefined };
    assert.deepEqual(await f.call('before_prompt_build', context), {
      prependContext: 'hidden instructions one',
    });
    assert.equal(f.loads(), 1);
    assert.deepEqual(await f.call('before_agent_run', context), { outcome: 'pass' });
    const events = f.events();
    assert.equal(events.find(({ outcome }) => outcome === 'ready').hook, 'before_agent_reply');
    assert.deepEqual(events.find(({ hook }) => hook === 'before_prompt_build').missing, ['jobId']);
  });

  it('should inject once per prompt projection at user priority and pin instructions until run completion', async () => {
    const f = fixture();
    await f.call('before_agent_reply');
    f.edit('hidden instructions two');
    assert.equal(await f.call('before_agent_reply'), undefined);
    for (let projection = 0; projection < 2; projection++)
      assert.deepEqual(await f.call('before_prompt_build'), {
        prependContext: 'hidden instructions one',
      });
    assert.equal(f.loads(), 1);
    await f.call('agent_end');
    assert.equal(await f.call('before_prompt_build'), undefined);
    await f.call('before_agent_reply', { ...f.context, runId: 'run-two' });
    assert.deepEqual(await f.call('before_prompt_build', { ...f.context, runId: 'run-two' }), {
      prependContext: 'hidden instructions two',
    });
    assert.equal(f.loads(), 2);
  });

  it('should handle missing, failed and empty instructions before either harness starts inference', async () => {
    for (const mode of ['failed', 'empty', 'observation'] as const) {
      const f = fixture();
      if (mode === 'failed') f.fail(new AutomationError('automation-lifecycle-drift'));
      if (mode === 'empty') f.edit('  ');
      if (mode === 'observation') f.loseObservation();
      const result = (await f.call('before_agent_reply')) as {
        handled: boolean;
        reply: { isError: boolean; text: string };
      };
      assert.equal(result.handled, true);
      assert.equal(result.reply.isError, true);
      assert.match(result.reply.text, /automation-prompt-load-blocked/);
      assert.equal(await f.call('before_prompt_build'), undefined);
      assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
      assert.ok(!f.logs.join().includes('private'));
    }
  });

  it('should defer embedded refusals to the native input gate without projecting unresolved instructions', async () => {
    for (const runtime of ['openclaw', ' OPENCLAW ']) {
      const f = fixture(runtime);
      f.fail(new AutomationError('automation-lifecycle-drift'));
      assert.equal(await f.call('before_agent_reply'), undefined);
      assert.equal(await f.call('before_prompt_build'), undefined);
      // repeated admission must not replace a failed entry with newly loaded instructions.
      f.edit('changed instructions');
      assert.equal(await f.call('before_agent_reply'), undefined);
      assert.equal(f.loads(), 1);
      const result = (await f.call('before_agent_run')) as { outcome: string; message: string };
      assert.equal(result.outcome, 'block');
      assert.match(result.message, /automation-prompt-load-blocked/);
      await f.call('agent_end');
    }
  });

  it('should select the failure path from the current model binding rather than the provider default', async () => {
    const embedded = fixture('codex');
    embedded.selectModelRuntime('openclaw');
    embedded.fail();
    assert.equal(await embedded.call('before_agent_reply'), undefined);
    assert.equal(
      ((await embedded.call('before_agent_run')) as { outcome: string }).outcome,
      'block',
    );
    const codex = fixture('openclaw');
    codex.selectModelRuntime('codex');
    codex.fail();
    assert.equal(((await codex.call('before_agent_reply')) as { handled: boolean }).handled, true);
  });

  it('should retain a pre-inference error reply when the native runtime cannot be established', async () => {
    for (const mode of [
      'missing-model',
      'unavailable-config',
      'other-runtime',
      'auto',
      'default',
      '',
    ]) {
      const f = fixture(['missing-model', 'unavailable-config'].includes(mode) ? 'openclaw' : mode);
      if (mode === 'unavailable-config') f.loseConfig();
      f.fail();
      const context = mode === 'missing-model' ? { ...f.context, modelId: undefined } : f.context;
      const result = (await f.call('before_agent_reply', context)) as {
        handled: boolean;
        reply: { isError: boolean };
      };
      assert.equal(result.handled, true);
      assert.equal(result.reply.isError, true);
      assert.equal(await f.call('before_prompt_build', context), undefined);
      assert.ok(!f.logs.join().includes('private'));
    }
  });

  it('should stop native admission when any scheduler binding field is missing', async () => {
    for (const key of [
      'runId',
      'jobId',
      'agentId',
      'workspaceDir',
      'sessionKey',
      'sessionId',
    ] as const) {
      const f = fixture();
      const context = { ...f.context, [key]: '' };
      const result = (await f.call('before_agent_reply', context)) as {
        handled: boolean;
        reply: { isError: boolean };
      };
      assert.equal(result.handled, true, key);
      assert.equal(result.reply.isError, true, key);
      assert.equal(f.loads(), 0);
      assert.equal(await f.call('before_prompt_build', context), undefined);
    }
  });

  it('should not inject instructions for changed run bindings or recover them from request prose', async () => {
    const f = fixture();
    await f.call('before_agent_reply');
    for (const key of [
      'runId',
      'jobId',
      'agentId',
      'workspaceDir',
      'sessionKey',
      'sessionId',
    ] as const) {
      const context = { ...f.context, [key]: 'other' };
      assert.equal(await f.call('before_prompt_build', context), undefined, key);
      assert.equal(
        ((await f.call('before_agent_run', context)) as { outcome: string }).outcome,
        'block',
        key,
      );
    }
    const other = fixture();
    assert.equal(
      await other.call('before_prompt_build', other.context, {
        prompt: '> Run scheduled automation: custom.',
      }),
      undefined,
    );
    assert.equal(other.loads(), 0);
  });

  it('should leave human turns, unrelated jobs, command jobs and legacy prompts unchanged', async () => {
    for (const mode of ['human', 'unrelated', 'command', 'legacy'] as const) {
      const f = fixture();
      if (mode === 'command') f.command();
      if (mode === 'legacy') f.edit(undefined);
      const context =
        mode === 'human'
          ? { ...f.context, trigger: 'user' }
          : mode === 'unrelated'
            ? { ...f.context, jobId: 'unrelated' }
            : f.context;
      assert.equal(await f.call('before_agent_reply', context), undefined);
      assert.equal(await f.call('before_prompt_build', context), undefined);
      assert.deepEqual(
        await f.call('before_agent_run', context),
        mode === 'legacy' ? { outcome: 'pass' } : undefined,
      );
      assert.equal(f.loads(), mode === 'legacy' ? 1 : 0);
    }
  });

  it('should retain redacted failure phases and known codes without arbitrary error details', async () => {
    for (const [error, reason] of [
      [new AutomationError('automation-lifecycle-drift'), 'automation-lifecycle-drift'],
      [Object.assign(new Error('private filesystem path'), { code: 'EACCES' }), 'EACCES'],
      [Object.assign(new Error('private token'), { code: 'private-code' }), 'unclassified'],
    ] as const) {
      const f = fixture();
      f.fail(error);
      await f.call('before_agent_reply');
      const failed = f.events().at(-1);
      assert.equal(failed.reason, reason);
      assert.equal(failed.phase, 'instructions');
      assert.equal(failed.outcome, 'failed');
      assert.ok(!f.logs.join().includes('private'));
    }
  });

  it('should distinguish pending registration from pending prompt preparation in the failure trace', async () => {
    const f = fixture();
    f.fail(new AutomationVerificationError('registration-pending'));
    await f.call('before_agent_reply');
    const failed = f.events().at(-1);
    assert.equal(failed.reason, 'automation-lifecycle-unverified');
    assert.equal(failed.check, 'registration-pending');
    assert.equal(failed.prepared, 'pending');
  });

  it('should hash binding correlation and preserve missing and changed field diagnostics', async () => {
    const f = fixture();
    await f.call('before_agent_reply');
    await f.call('before_prompt_build');
    await f.call('before_agent_run', { ...f.context, sessionId: 'changed-private-session' });
    assert.deepEqual(f.events().at(-1).changed, ['sessionId']);
    for (const event of f.events().slice(0, -2))
      for (const [key, value] of Object.entries(f.context).filter(
        ([key]) => !['trigger', 'modelProviderId', 'modelId'].includes(key),
      ))
        assert.equal(
          event.identity[key],
          createHash('sha256').update(value).digest('hex').slice(0, 16),
        );
    for (const value of [
      ...Object.entries(f.context)
        .filter(([key]) => !['trigger', 'modelProviderId', 'modelId'].includes(key))
        .map(([, value]) => value),
      'hidden instructions one',
      'changed-private-session',
    ])
      assert.ok(!f.logs.join().includes(JSON.stringify(value)));
    const missing = fixture();
    await missing.call('before_agent_reply', { ...missing.context, jobId: '' });
    const failed = missing.events().at(-1);
    assert.deepEqual(failed.missing, ['jobId']);
    assert.equal(failed.identity.jobId, null);
    assert.equal(failed.reason, 'automation-prompt-binding-missing');
    assert.equal(failed.phase, 'selection');
  });

  it('should reject prompt projections after their native hook lifetime expires', async () => {
    const f = fixture();
    await f.call('before_agent_reply');
    assert.throws(
      () =>
        f.call('before_prompt_build', {
          ...f.context,
          hookInvocation: {
            assertActive() {
              throw new Error('expired');
            },
          },
        }),
      /expired/,
    );
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
  });

  it('should keep the embedded input gate closed until prompt projection actually occurs', async () => {
    const f = fixture();
    await f.call('before_agent_reply');
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
    await f.call('before_prompt_build');
    assert.deepEqual(await f.call('before_agent_run'), { outcome: 'pass' });
  });
});
