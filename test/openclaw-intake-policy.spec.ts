import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

function manifest(): AgentManifest {
  const { policy } = intakeFixture();
  return {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    automations: [
      {
        id: 'independent-check',
        enabled: true,
        runtimes: ['openclaw'],
        schedule: { kind: 'every', seconds: 3600, missedRun: 'native' },
        overrides: {},
        payload: { kind: 'command', run: { kind: 'exec', executable: 'true', args: [] } },
      },
    ],
    github: { username: 'receiver', notifications: { ...policy, runtimes: ['openclaw'] } },
  };
}

describe('agent/openclaw-intake-policy', () => {
  it('should wake intake without appending workflow instructions to the visible request', async () => {
    const value = manifest();
    value.models = { default: { model: 'openai/test', effort: 'medium' } };
    const job = openclawIntakeJobs(value).find((job) => job.id === 'github-issue-assignment')!;
    for (const diagnostic of [undefined, { phase: 'discovery', code: 'intake-scan-incomplete' }]) {
      let result: { fire: boolean; message?: string } | undefined;
      await runInNewContext(`(async()=>{${job.internalOpenClaw!.trigger.script}})()`, {
        agent_system_dispatch: async () => ({ status: 'ready', changed: true, diagnostic }),
        json: (value: typeof result) => {
          result = value;
        },
      });
      assert.equal(result?.fire, true);
      if (diagnostic) assert.match(result?.message ?? '', /intake-scan-incomplete/);
      else assert.equal(result?.message, undefined);
      assert.equal(
        (result?.message ?? '').includes('Fill initially available intake slots'),
        false,
      );
    }
  });

  it('should preserve bounded failure codes without mistaking contention for authorization loss', async () => {
    const value = manifest();
    value.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
    const script = openclawIntakeJobs(value).find((job) => job.id === 'github-issue-assignment')!
      .internalOpenClaw!.trigger!.script;
    for (const [message, code, status] of [
      ['private-state-file-lock-busy', 'private-state-file-lock-busy', 'busy'],
      ['intake-github-permission', 'intake-github-permission', 'failed'],
      ['secret provider response with spaces', 'dispatch-condition-failed', 'failed'],
    ]) {
      let result: { state: { code: string; status: string } } | undefined;
      await runInNewContext('(async()=>{' + script + '})()', {
        agent_system_dispatch: async () => {
          throw new Error(message);
        },
        json: (value: typeof result) => {
          result = value;
        },
      });
      assert.equal(result?.state.code, code);
      assert.equal(result?.state.status, status);
    }
  });
  it('should retain discovery and unrelated jobs when a workflow stage is unsupported', () => {
    for (const change of [
      { mode: 'work' as const },
      { mode: 'auto' as const },
      { assessment: { skill: 'custom:assessment' } },
    ]) {
      const value = manifest();
      value.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
      Object.assign(value.github!.notifications!.issueAssignment!, change);
      assert.equal(
        openclawIntakeJobs(value).some((job) => job.id === 'github-issue-assignment'),
        true,
      );
    }
  });

  it('should retain the assignment schedule with feedback enabled and reviews unavailable', () => {
    const value = manifest();
    value.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
    value.github!.notifications!.issueAssignment!.feedback = { inherit: true, allowed: [] };
    value.github!.notifications!.reviewRequest = {
      paused: false,
      allowed: [{ login: 'operator', nodeId: 'U_operator' }],
    };
    const jobs = openclawIntakeJobs(value);
    assert.deepEqual(
      jobs.find(({ id }) => id === 'independent-check'),
      value.automations![0],
    );
    const assignment = jobs.find(({ id }) => id === 'github-issue-assignment');
    assert.ok(assignment);
    assert.equal(assignment.displayName, '📥 ISSUE ASSIGNMENTS');
    assert.deepEqual(assignment.thread, { name: 'ISSUE ASSIGNMENTS' });
    assert.equal(assignment.enabled, true);
  });

  it('should still derive supported planning when unsupported triggers are disabled', () => {
    const value = manifest();
    value.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
    value.github!.notifications!.reviewRequest = { paused: true, allowed: [] };
    const jobs = openclawIntakeJobs(value);
    assert.deepEqual(
      jobs.find(({ id }) => id === 'independent-check'),
      value.automations![0],
    );
    const assignment = jobs.find(({ id }) => id === 'github-issue-assignment');
    assert.ok(assignment);
    assert.equal(assignment.enabled, true);
  });
});
