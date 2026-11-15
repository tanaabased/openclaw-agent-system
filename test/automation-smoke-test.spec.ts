import assert from 'node:assert/strict';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import automationSmokeTest, {
  automationSmokeTestId,
  automationSmokeTestRequest,
} from '../agent/automations/automation-smoke-test.ts';
import { projectAutomation } from '../agent/automations/automation-projection.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import { codexIntakeJobs } from '../agent/automations/codex-intake-policy.ts';
import registerAutomationSmokeHooks from '../core/automation-smoke-hook.ts';

describe('agent/automation-smoke-test', () => {
  it('should offer a disabled openclaw pilot without requiring github or model configuration', () => {
    const manifest = { schemaVersion: 1 as const, agent: { id: 'test' } };
    const job = openclawIntakeJobs(manifest).find(({ id }) => id === automationSmokeTestId)!;
    assert.equal(job.enabled, false);
    assert.deepEqual(job.runtimes, ['openclaw']);
    assert.equal(
      codexIntakeJobs(manifest).some(({ id }) => id === job.id),
      false,
    );
    assert.throws(() => openclawIntakeJobs({ ...manifest, automations: [job] }), /reserved/);
  });
  it('should compact only the trusted pilot without changing ordinary prompt projection', () => {
    const job = automationSmokeTest();
    const context = {
      agentId: 'test',
      workspaceDir: '/workspace',
      command: [],
      environment: {},
      timezone: 'UTC',
    };
    const record = {
      id: job.id,
      marker: 'marker',
      hash: '',
      triggerHash: '',
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    assert.equal(
      projectAutomation(job, record, context).payload.message,
      automationSmokeTestRequest,
    );
    assert.ok(!automationSmokeTestRequest.includes('violet-47'));
    delete job.origin;
    assert.equal(
      projectAutomation(job, record, context).payload.message,
      job.payload.kind === 'prompt' ? job.payload.prompt : undefined,
    );
  });
});

function fixture() {
  const hooks = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  let instruction = 'hidden marker one';
  let failure = false;
  let loads = 0;
  const logs: string[] = [];
  const context = {
    trigger: 'cron',
    runId: 'run-one',
    jobId: 'native-pilot',
    agentId: 'test',
    workspaceDir: '/workspace',
    sessionKey: 'agent:test:pilot',
    sessionId: 'session',
  };
  registerAutomationSmokeHooks(
    {
      on: ((name, handler) => hooks.set(name, handler as never)) as OpenClawPluginApi['on'],
      logger: {
        info: (text) => logs.push(text),
        warn: (text) => logs.push(text),
        error() {},
        debug() {},
      },
    },
    () =>
      ({
        isEnabled: () => true,
        list: async () => [
          {
            id: 'native-pilot',
            agentId: 'test',
            declarationKey: `agent-system:scope:${automationSmokeTestId}`,
          },
        ],
      }) as never,
    async () => {
      loads++;
      if (failure) throw new Error('private diagnostic');
      return instruction;
    },
  );
  return {
    context,
    logs,
    call: (hook: string, ctx = context, event: unknown = {}) => hooks.get(hook)!(event, ctx),
    edit: () => {
      instruction = 'hidden marker two';
    },
    fail: () => {
      failure = true;
    },
    loads: () => loads,
  };
}

describe('core/automation-smoke-hook', () => {
  it('should inject only user-level context and pin one exact instruction per native run', async () => {
    const f = fixture();
    assert.deepEqual(await f.call('before_prompt_build'), { prependContext: 'hidden marker one' });
    assert.deepEqual(await f.call('before_agent_run'), { outcome: 'pass' });
    f.edit();
    assert.deepEqual(await f.call('before_prompt_build'), { prependContext: 'hidden marker one' });
    assert.equal(f.loads(), 1);
    assert.deepEqual(await f.call('before_prompt_build', { ...f.context, runId: 'run-two' }), {
      prependContext: 'hidden marker two',
    });
    assert.equal(f.loads(), 2);
  });
  it('should leave copied human requests and unrelated native jobs untouched', async () => {
    const f = fixture();
    for (const context of [
      { ...f.context, trigger: 'user' },
      { ...f.context, jobId: 'unrelated' },
      { ...f.context, agentId: 'peer' },
    ]) {
      assert.equal(
        await f.call('before_prompt_build', context, { prompt: automationSmokeTestRequest }),
        undefined,
      );
      assert.equal(await f.call('before_agent_run', context), undefined);
    }
    assert.equal(f.loads(), 0);
  });
  it('should block known pilot runs when loading fails or the prompt hook did not prepare them', async () => {
    const f = fixture();
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
    f.fail();
    assert.equal(await f.call('before_prompt_build'), undefined);
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
    assert.ok(!f.logs.join().includes('private diagnostic'));
  });
  it('should reject changed run bindings and clear prepared context after completion', async () => {
    const f = fixture();
    await f.call('before_prompt_build');
    for (const key of ['jobId', 'agentId', 'workspaceDir', 'sessionKey', 'sessionId'] as const)
      assert.equal(
        (
          (await f.call('before_agent_run', { ...f.context, [key]: 'other' })) as {
            outcome: string;
          }
        ).outcome,
        'block',
      );
    await f.call('agent_end');
    assert.equal(((await f.call('before_agent_run')) as { outcome: string }).outcome, 'block');
  });
  it('should report the actual harness from output evidence even when context omits the run id', async () => {
    const f = fixture();
    await f.call('before_prompt_build');
    await f.call(
      'llm_output',
      { ...f.context, runId: '' },
      {
        runId: f.context.runId,
        harnessId: 'codex',
        provider: 'openai',
        model: 'test-model',
      },
    );
    assert.ok(f.logs.some((line) => line.includes('"harness":"codex"')));
  });
  it('should block tool effects only during a selected smoke run', async () => {
    const f = fixture();
    assert.equal(await f.call('before_tool_call'), undefined);
    await f.call('before_prompt_build');
    assert.equal(((await f.call('before_tool_call')) as { block: boolean }).block, true);
    assert.equal(await f.call('before_tool_call', { ...f.context, runId: 'unrelated' }), undefined);
    await f.call('agent_end');
    assert.equal(await f.call('before_tool_call'), undefined);
  });
});
