import assert from 'node:assert/strict';

import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
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
    value.github!.notifications!.issueAssignment!.feedback = true;
    value.github!.notifications!.reviewRequest = {
      enabled: true,
      allowed: [{ login: 'operator', nodeId: 'U_operator' }],
    };
    const jobs = openclawIntakeJobs(value);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs[0], value.automations![0]);
    assert.equal(jobs[1]?.id, 'github-issue-assignment');
    assert.equal(jobs[1]?.enabled, true);
  });

  it('should still derive supported planning when unsupported triggers are disabled', () => {
    const value = manifest();
    value.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
    value.github!.notifications!.reviewRequest = { enabled: false, allowed: [] };
    const jobs = openclawIntakeJobs(value);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs[0], value.automations![0]);
    assert.equal(jobs[1]?.id, 'github-issue-assignment');
    assert.equal(jobs[1]?.enabled, true);
  });
});
