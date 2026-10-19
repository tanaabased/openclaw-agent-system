import assert from 'node:assert/strict';

import assignmentIntakePolicy from '../agent/assignment-intake-policy.ts';
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
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should keep ${runtime} installed orchestration stable across live policy edits`, () => {
      const manifest = fixture();
      const jobs = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const before = jobs(manifest)[0]!;
      const policy = manifest.github!.notifications!;
      policy.issueAssignment!.mode = 'work';
      policy.issueAssignment!.feedback = true;
      policy.issueAssignment!.allowed = [];
      policy.maxConcurrentItems = 8;
      policy.cleanup = { enabled: false, graceMinutes: 30 };
      manifest.debug = true;
      assert.deepEqual(jobs(manifest)[0], before);
      assert.equal(assignmentIntakePolicy(manifest, runtime)?.policy.maxConcurrentItems, 8);
      policy.intervalMinutes = 17;
      assert.notDeepEqual(jobs(manifest)[0]!.schedule, before.schedule);
      assert.deepEqual(jobs(manifest)[0]!.payload, before.payload);
    });
  }
});
