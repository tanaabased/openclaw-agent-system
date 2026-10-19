import assert from 'node:assert/strict';

import { automationHash } from '../agent/automation-hash.ts';
import {
  notificationAuthorityDigest,
  matchesNotificationAuthority,
} from '../agent/notification-authority.ts';
import assignmentIntakePolicy, {
  matchesIntakePolicy,
  originalIntakePolicyDigest,
} from '../agent/assignment-intake-policy.ts';
import { codexIntakeJobs } from '../agent/codex-intake-policy.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture, originalIntakeDigest } from './github-intake-fixture.ts';

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

describe('assignment intake authority', () => {
  it('should reproduce the original ordered format without granting intake activation', () => {
    for (const host of [undefined, 'github.com'] as const) {
      const manifest = fixture();
      manifest.github!.host = host;
      const original = originalIntakeDigest(manifest);
      assert.equal(originalIntakePolicyDigest(manifest), original);
      const current = assignmentIntakePolicy(manifest, 'openclaw')!;
      assert.notEqual(original, current.digest);
      assert.notEqual(original, current.legacyDigest);
      assert.equal(matchesIntakePolicy(original, current), false);
    }
  });
  const originalChanges: Record<string, (value: AgentManifest) => void> = {
    identity: (value) => {
      value.github!.username = 'foreign';
    },
    host: (value) => {
      value.github!.host = undefined;
    },
    runtimes: (value) => {
      value.github!.notifications!.runtimes = ['openclaw'];
    },
    order: (value) => {
      value.github!.notifications!.runtimes.reverse();
    },
    cadence: (value) => {
      value.github!.notifications!.intervalMinutes++;
    },
    capacity: (value) => {
      value.github!.notifications!.maxConcurrentItems++;
    },
    owner: (value) => {
      value.github!.notifications!.allowedRepositoryOwners[0]!.nodeId = 'foreign';
    },
    actor: (value) => {
      value.github!.notifications!.issueAssignment!.allowed[0]!.nodeId = 'foreign';
    },
    'operator-owner': (value) => {
      value.github!.notifications!.issueAssignment!.allowed[0]!.operatorOwner = true;
    },
    mode: (value) => {
      value.github!.notifications!.issueAssignment!.mode = 'work';
    },
    assessment: (value) => {
      value.github!.notifications!.issueAssignment!.assessment = { skill: 'other' };
    },
    implementation: (value) => {
      value.github!.notifications!.issueAssignment!.implementation = { guidance: 'different' };
    },
    feedback: (value) => {
      value.github!.notifications!.issueAssignment!.feedback = true;
    },
    recipients: (value) => {
      value.github!.notifications!.issueAssignment!.pullRequest = {
        recipients: [{ source: 'assignment-actor', roles: ['assignee'] }],
      };
    },
  };
  for (const [name, change] of Object.entries(originalChanges)) {
    it(`should reject an original receipt after changed ${name}`, () => {
      const manifest = fixture();
      const before = originalIntakeDigest(manifest);
      change(manifest);
      assert.notEqual(originalIntakePolicyDigest(manifest), before);
    });
  }
  it('should recognize only unchanged legacy intake authority', () => {
    const manifest = fixture();
    manifest.github!.notifications!.runtimes = ['openclaw', 'codex'];
    const original = assignmentIntakePolicy(manifest, 'codex')!;
    assert.notEqual(original.legacyDigest, original.digest);
    assert.ok(matchesIntakePolicy(original.legacyDigest, original));
    assert.ok(matchesIntakePolicy(original.digest, original));
    assert.equal(matchesIntakePolicy(undefined, original), false);
    manifest.github!.notifications!.issueAssignment!.allowed[0]!.nodeId = 'foreign';
    const changed = assignmentIntakePolicy(manifest, 'codex')!;
    assert.equal(matchesIntakePolicy(original.legacyDigest, changed), false);
    assert.equal(matchesIntakePolicy(original.digest, changed), false);
  });
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should keep ${runtime} authority stable while operational settings still take effect`, () => {
      const manifest = fixture();
      const before = assignmentIntakePolicy(manifest, runtime)!;
      const jobs = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const original = jobs(manifest)[0]!;
      const policy = manifest.github!.notifications!;
      policy.intervalMinutes = 17;
      policy.maxConcurrentItems = 8;
      policy.cleanup = { enabled: true, graceMinutes: 30 };
      manifest.debug = true;
      const after = assignmentIntakePolicy(manifest, runtime)!;
      assert.equal(after.digest, before.digest);
      assert.equal(after.policy.maxConcurrentItems, 8);
      assert.equal(after.policy.cleanup?.graceMinutes, 30);
      const updated = jobs(manifest)[0]!;
      assert.deepEqual(updated.schedule, { kind: 'every', missedRun: 'native', seconds: 1020 });
      assert.deepEqual(updated.payload, original.payload);
    });
  }
  it('should retain unchanged legacy grants without assuming changed legacy policies are equivalent', () => {
    const policy = fixture().github!.notifications!;
    const legacy = automationHash(policy);
    const current = notificationAuthorityDigest(policy);
    assert.equal(matchesNotificationAuthority(legacy, policy), true);
    policy.intervalMinutes += 1;
    assert.equal(matchesNotificationAuthority(current, policy), true);
    assert.equal(matchesNotificationAuthority(legacy, policy), false);
    policy.issueAssignment!.mode = 'work';
    assert.equal(matchesNotificationAuthority(current, policy), false);
  });
  for (const change of [
    'identity',
    'runtime',
    'owner',
    'actor',
    'mode',
    'feedback',
    'cleanup',
  ] as const) {
    it(`should continue detecting changed ${change} authority`, () => {
      const manifest = fixture();
      const before = assignmentIntakePolicy(manifest, 'codex')!.digest;
      const github = manifest.github!;
      const policy = github.notifications!;
      if (change === 'identity') github.username = 'someone';
      if (change === 'runtime') policy.runtimes = ['openclaw'];
      if (change === 'owner') policy.allowedRepositoryOwners[0]!.nodeId = 'foreign';
      if (change === 'actor') policy.issueAssignment!.allowed[0]!.nodeId = 'foreign';
      if (change === 'mode') policy.issueAssignment!.mode = 'work';
      if (change === 'feedback') policy.issueAssignment!.feedback = true;
      if (change === 'cleanup') policy.cleanup = { enabled: false, graceMinutes: 60 };
      assert.notEqual(assignmentIntakePolicy(manifest, 'codex')?.digest, before);
    });
  }
});
