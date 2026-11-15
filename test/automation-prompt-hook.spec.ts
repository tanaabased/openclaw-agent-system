import assert from 'node:assert/strict';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import registerAutomationPromptHooks from '../core/automation-prompt-hook.ts';

function fixture() {
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  let prompt: string | undefined = 'hidden instructions one';
  let failure = false;
  let observationFailure = false;
  let loads = 0;
  let payloadKind = 'agentTurn';
  const logs: string[] = [];
  const context = {
    trigger: 'cron',
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
      logger: { info() {}, warn: (text) => logs.push(text), error() {}, debug() {} },
    },
    () =>
      ({
        list: async () => {
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
      }) as never,
    async () => {
      loads++;
      if (failure) throw new Error('private filesystem diagnostic');
      return { prompt };
    },
  );
  return {
    context,
    logs,
    call: (hook: string, ctx = context, event: unknown = {}) => hooks.get(hook)!(event, ctx),
    edit: (value: string | undefined) => {
      prompt = value;
    },
    fail: () => {
      failure = true;
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
  it('should inject at user priority and pin the instructions to one exact native run', async () => {
    const f = fixture();
    assert.deepEqual(await f.call('before_prompt_build'), {
      prependContext: 'hidden instructions one',
    });
    assert.deepEqual(await f.call('before_agent_run'), { outcome: 'pass' });
    f.edit('hidden instructions two');
    assert.deepEqual(await f.call('before_prompt_build'), {
      prependContext: 'hidden instructions one',
    });
    assert.equal(f.loads(), 1);
    assert.deepEqual(await f.call('before_prompt_build', { ...f.context, runId: 'run-two' }), {
      prependContext: 'hidden instructions two',
    });
    assert.equal(f.loads(), 2);
  });
  it('should ignore copied human requests and unrelated native jobs', async () => {
    const f = fixture();
    for (const context of [
      { ...f.context, trigger: 'user' },
      { ...f.context, jobId: 'unrelated' },
      { ...f.context, agentId: 'peer' },
    ]) {
      assert.equal(
        await f.call('before_prompt_build', context, {
          prompt: '> Run scheduled automation: custom.',
        }),
        undefined,
      );
      assert.equal(await f.call('before_agent_run', context), undefined);
    }
    assert.equal(f.loads(), 0);
  });
  it('should leave command jobs and their report turns unchanged', async () => {
    const f = fixture();
    f.command();
    assert.equal(await f.call('before_prompt_build'), undefined);
    assert.equal(await f.call('before_agent_run'), undefined);
    assert.equal(f.loads(), 0);
  });
  it('should stop cron execution when native binding fields are missing', async () => {
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
      assert.equal(await f.call('before_prompt_build', context), undefined);
      assert.equal(
        ((await f.call('before_agent_run', context)) as { outcome: string }).outcome,
        'block',
      );
    }
  });
  it('should block an owned run with a missing prompt hook, failed load or empty instructions', async () => {
    for (const mode of ['missing', 'failed', 'empty', 'observation'] as const) {
      const f = fixture();
      if (mode === 'failed') f.fail();
      if (mode === 'empty') f.edit('  ');
      if (mode === 'observation') f.loseObservation();
      if (mode !== 'missing') assert.equal(await f.call('before_prompt_build'), undefined);
      assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
      assert.ok(!f.logs.join().includes('private'));
    }
  });
  it('should reject mismatched bindings and discard prepared instructions at completion', async () => {
    const f = fixture();
    await f.call('before_prompt_build');
    for (const key of ['jobId', 'agentId', 'workspaceDir', 'sessionKey', 'sessionId'] as const) {
      assert.equal(
        await f.call('before_prompt_build', { ...f.context, [key]: 'other' }),
        undefined,
      );
      assert.equal(
        (
          (await f.call('before_agent_run', { ...f.context, [key]: 'other' })) as {
            outcome: string;
          }
        ).outcome,
        'block',
      );
    }
    await f.call('agent_end');
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
    f.edit('next run instructions');
    assert.deepEqual(await f.call('before_prompt_build'), {
      prependContext: 'next run instructions',
    });
  });
  it('should allow verified legacy full-prompt jobs without injecting a duplicate', async () => {
    const f = fixture();
    f.edit(undefined);
    assert.equal(await f.call('before_prompt_build'), undefined);
    assert.deepEqual(await f.call('before_agent_run'), { outcome: 'pass' });
  });
  it('should stop when native prompt-hook lifetime expires before loading completes', async () => {
    const f = fixture();
    const context = {
      ...f.context,
      hookInvocation: {
        assertActive() {
          throw new Error('expired');
        },
      },
    };
    assert.equal(await f.call('before_prompt_build', context), undefined);
    assert.equal(
      ((await f.call('before_agent_run', context)) as { outcome: string }).outcome,
      'block',
    );
  });
});
