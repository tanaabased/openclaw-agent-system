import assert from 'node:assert/strict';

import assignmentIntakePolicy from '../agent/assignment-intake-policy.ts';
import retainedIntakePolicy from '../agent/retained-intake-policy.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import { codexIntakeJobs } from '../agent/codex-intake-policy.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

function fixture(): AgentManifest {
  return {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    models: {
      default: { model: 'openai/gpt-6-luna', effort: 'medium' },
      low: { model: 'openai/gpt-6-luna', effort: 'medium' },
    },
    github: {
      host: 'github.com',
      username: 'receiver',
      notifications: {
        ...structuredClone(intakeFixture().policy),
        runtimes: ['codex', 'openclaw'],
      },
    },
  };
}

describe('assignment intake policy', () => {
  it('should retain required schedules with an empty admission list and no review-only activation', () => {
    const manifest = fixture();
    manifest.github!.notifications!.issueAssignment!.allowed = [];
    assert.equal(codexIntakeJobs(manifest).length, 1);
    assert.equal(openclawIntakeJobs(manifest).length, 1);
    manifest.github!.notifications!.reviewRequest = { allowed: [] };
    delete manifest.github!.notifications!.issueAssignment;
    assert.equal(codexIntakeJobs(manifest).length, 0);
    assert.equal(openclawIntakeJobs(manifest).length, 0);
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should retain ${runtime} authority and scheduler identity across pause and resume`, () => {
      const manifest = fixture();
      const jobs = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const active = jobs(manifest)[0]!;
      const authority = assignmentIntakePolicy(manifest, runtime)!.digest;
      manifest.github!.notifications!.issueAssignment!.paused = true;
      assert.deepEqual(jobs(manifest)[0], { ...active, enabled: false });
      assert.equal(assignmentIntakePolicy(manifest, runtime)!.digest, authority);
      manifest.github!.notifications!.issueAssignment!.paused = false;
      assert.deepEqual(jobs(manifest)[0], active);
      assert.equal(assignmentIntakePolicy(manifest, runtime)!.digest, authority);
    });
    it(`should not restore ${runtime} feedback grants from retained assignment actors`, () => {
      const manifest = fixture();
      const state = {
        version: 1 as const,
        scope: 'retained',
        workspaceDir: '/workspace',
        agentId: 'receiver',
        account: { login: 'receiver', nodeId: 'U_receiver', type: 'User' },
        policyDigest: 'original',
        baselineAt: 0,
        records: [],
      };
      const configured = retainedIntakePolicy(manifest, state, runtime).policy.issueAssignment!;
      assert.deepEqual(feedbackIdentities(configured.allowed, configured.feedback), [
        { login: 'receiver', nodeId: 'U_receiver' },
      ]);
      delete manifest.github!.notifications!.issueAssignment;
      const removed = retainedIntakePolicy(manifest, state, runtime).policy.issueAssignment!;
      assert.deepEqual(feedbackIdentities(removed.allowed, removed.feedback), []);
      delete manifest.github!.notifications;
      const absent = retainedIntakePolicy(manifest, state, runtime).policy.issueAssignment!;
      assert.deepEqual(feedbackIdentities(absent.allowed, absent.feedback), []);
    });
    it(`should keep ${runtime} installed orchestration stable across live policy edits`, () => {
      const manifest = fixture();
      const jobs = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const before = jobs(manifest)[0]!;
      const policy = manifest.github!.notifications!;
      policy.issueAssignment!.mode = 'work';
      policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
      policy.issueAssignment!.allowed = [];
      policy.maxConcurrentItems = 8;
      manifest.debug = true;
      assert.deepEqual(jobs(manifest)[0], before);
      assert.equal(assignmentIntakePolicy(manifest, runtime)?.policy.maxConcurrentItems, 8);
      policy.intervalMinutes = 17;
      assert.notDeepEqual(jobs(manifest)[0]!.schedule, before.schedule);
      assert.deepEqual(jobs(manifest)[0]!.payload, before.payload);
    });
  }
});
