import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import ProjectPickupEnrollmentStore from '../agent/project-pickup-enrollment.ts';
import projectPickupJobs, { projectPickupConfigurationCode } from '../agent/project-pickup-jobs.ts';
import parseAgentManifest from '../manifest/parse.ts';
import selectionFixture from './project-pickup-selection-fixture.ts';

describe('project pickup installation enrollment', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pickup-enrollment-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    async function fixture() {
      const f = selectionFixture(runtime);
      const identity = new AssignmentClaimStore(root);
      const installed = await identity.identity();
      f.policy.projectPickup!.coordinator = { runtime, instanceId: installed.instanceId };
      const store = new ProjectPickupEnrollmentStore(root);
      const input = {
        policy: f.policy,
        runtime,
        scope: 'scope',
        workspaceDir: '/workspace',
        agentId: 'receiver',
        client: f.client,
        timezone: 'UTC',
        now: f.clock.now,
      };
      return { ...f, store, identity, input };
    }

    it(`should retain the enrollment anchor and native job across install and pause in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      await f.store.activate(first.enrollment.id, 'native-job');
      f.policy.projectPickup!.paused = true;
      f.policy.projectPickup!.selection = { guidance: 'updated priorities' };
      const again = await f.store.prepare({ ...f.input, now: f.clock.now + 86400000 });
      assert.deepEqual(again, { ...first, nativeId: 'native-job' });
      assert.deepEqual(await f.store.inspect(f.policy, runtime, 'scope'), again);
      await assert.rejects(
        f.store.activate(first.enrollment.id, 'replacement'),
        /enrollment-changed/,
      );
      assert.equal((await f.store.read()).records.length, 1);
    });

    it(`should reject a conflicting local coordinator and changed policy without replacing ownership in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      await assert.rejects(
        f.store.prepare({ ...f.input, scope: 'other', workspaceDir: '/other' }),
        /coordinator-conflict/,
      );
      await assert.rejects(
        f.store.prepare({ ...f.input, timezone: 'America/New_York' }),
        /enrollment-changed/,
      );
      f.policy.projectPickup!.windowMinutes++;
      await assert.rejects(f.store.prepare(f.input), /enrollment-changed/);
      assert.deepEqual((await f.store.read()).records, [first]);
    });

    it(`should reject another installation and rotation before provider access in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      f.client.getRepository = async () => {
        assert.fail('provider access before ownership');
      };
      const otherRoot = join(root, 'other');
      await new AssignmentClaimStore(otherRoot).identity();
      await assert.rejects(
        new ProjectPickupEnrollmentStore(otherRoot).prepare(f.input),
        /coordinator-mismatch/,
      );
      await f.identity.rotate(first.instanceId);
      await assert.rejects(f.store.prepare(f.input), /coordinator-mismatch/);
      assert.deepEqual((await f.store.read()).records, [first]);
    });
  }

  it('should inspect missing installation state without creating files', async () => {
    const f = selectionFixture();
    const store = new ProjectPickupEnrollmentStore(root);
    await assert.rejects(store.owner(f.policy, 'codex'), /coordinator-required/);
    assert.deepEqual(await readdir(root), []);
  });

  it('should derive one native job with runtime model routing and reject unsupported designation or cadence', () => {
    const source = {
      'schema-version': 1,
      agent: { id: 'receiver' },
      models: {
        default: { model: 'openai/gpt-6-astra', effort: 'high' },
        low: { model: 'openai/gpt-6-luna', effort: 'medium' },
        medium: { model: 'openai/gpt-6-astra', effort: 'high' },
        high: { model: 'openai/gpt-6-astra', effort: 'high' },
      },
      github: {
        username: 'receiver',
        runtimes: ['codex', 'openclaw'],
        'interval-minutes': 5,
        'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
        'issue-assignment': { allowed: [{ login: 'operator', 'node-id': 'U_operator' }] },
        'project-pickup': {
          coordinator: { runtime: 'codex', 'instance-id': '00000000-0000-4000-8000-000000000001' },
          schedule: 'every 1 day',
          'window-minutes': 10,
          projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' } }],
        },
      },
    };
    const parsed = parseAgentManifest(JSON.stringify(source));
    assert.equal(parsed.status, 'valid', JSON.stringify(parsed));
    if (parsed.status !== 'valid') throw Error('invalid fixture');
    const manifest = parsed.manifest;
    const policy = manifest.github!.notifications!;
    for (const runtime of ['codex', 'openclaw'] as const) {
      policy.projectPickup!.coordinator!.runtime = runtime;
      const jobs = projectPickupJobs(manifest, runtime);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.id, 'github-project-pickup');
      assert.deepEqual(jobs[0]!.schedule, { kind: 'every', seconds: 300, missedRun: 'native' });
      assert.equal(
        jobs[0]!.overrides?.[runtime]?.model,
        runtime === 'codex' ? 'gpt-6-luna' : 'openai/gpt-6-astra',
      );
      policy.projectPickup!.paused = true;
      assert.equal(projectPickupJobs(manifest, runtime)[0]!.enabled, false);
      policy.projectPickup!.paused = false;
      assert.deepEqual(projectPickupJobs(manifest, runtime === 'codex' ? 'openclaw' : 'codex'), []);
      policy.projectPickup!.windowMinutes = 4;
      assert.equal(
        projectPickupConfigurationCode(policy, runtime),
        'project-pickup-schedule-unsupported',
      );
      policy.projectPickup!.windowMinutes = 10;
    }
    delete policy.projectPickup!.coordinator;
    assert.equal(
      projectPickupConfigurationCode(policy, 'codex'),
      'project-pickup-coordinator-required',
    );
  });
});
