import reconcileProjectPickup from '../agent/project-pickup-reconcile.ts';
import type { ProjectPickupState } from '../agent/project-pickup-state.ts';
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
      await identity.identity();
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

    it(`should reject a conflicting enrollment and changed policy without replacing ownership in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      await assert.rejects(
        f.store.prepare({ ...f.input, scope: 'other', workspaceDir: '/other' }),
        /enrollment-conflict/,
      );
      await assert.rejects(
        f.store.prepare({ ...f.input, timezone: 'America/New_York' }),
        /enrollment-changed/,
      );
      f.policy.projectPickup!.windowMinutes++;
      await assert.rejects(f.store.prepare(f.input), /enrollment-changed/);
      assert.deepEqual((await f.store.read()).records, [first]);
    });

    it(`should change milestone with retained work and keep original receipts in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      await f.store.activate(first.enrollment.id, 'native-job');
      const receipt = {
        enrollmentId: first.enrollment.id,
        issueNodeId: 'I_old',
        assignmentNodeId: 'E_old',
        window: { id: 'window', opensAt: f.clock.now, closesAt: f.clock.now + 60000 },
      };
      const state: { projectPickup?: ProjectPickupState } = {
        projectPickup: {
          enrollment: first.enrollment,
          timezone: 'UTC',
          highWater: f.clock.now,
          operations: [
            {
              id: 'delivered',
              window: receipt.window,
              phase: 'admitted',
              page: 1,
              candidates: [],
              receipt,
            },
            {
              id: 'uncertain',
              window: receipt.window,
              phase: 'attempted',
              page: 1,
              candidates: [],
              attemptedAt: f.clock.now,
            },
            {
              id: 'selection',
              window: receipt.window,
              phase: 'selecting',
              page: 1,
              candidates: [],
            },
          ],
        },
      };
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_new';
      let saves = 0;
      const updated = await f.store.prepare({
        ...f.input,
        reconcile: (record, commit, before) =>
          reconcileProjectPickup(
            state,
            async () => {
              saves++;
            },
            record,
            commit,
            before,
          ),
      });
      assert.equal(updated.enrollment.milestoneNodeId, 'MI_new');
      assert.equal(updated.enrollment.startedAt, first.enrollment.startedAt);
      assert.equal(updated.nativeId, 'native-job');
      assert.equal(state.projectPickup!.highWater, f.clock.now);
      assert.deepEqual(state.projectPickup!.operations[0]!.receipt, receipt);
      assert.equal(state.projectPickup!.operations[0]!.enrollment!.milestoneNodeId, 'MI_pilot');
      assert.equal(state.projectPickup!.operations[1]!.phase, 'attempted');
      assert.equal(state.projectPickup!.operations[2]!.phase, 'cancelled');
      assert.equal(saves, 1);
      await f.store.activate(updated.enrollment.id, 'native-job');
      assert.equal((await f.store.inspect(f.policy, runtime, 'scope')).nativeId, 'native-job');
    });

    it(`should enroll participants independently and retain identity after rotation in ${runtime}`, async () => {
      const f = await fixture();
      const first = await f.store.prepare(f.input);
      const otherRoot = join(root, 'other');
      await new AssignmentClaimStore(otherRoot).identity();
      const other = await new ProjectPickupEnrollmentStore(otherRoot).prepare(f.input);
      assert.notEqual(other.instanceId, first.instanceId);
      assert.notEqual(other.enrollment.id, first.enrollment.id);
      await f.identity.rotate(first.instanceId);
      await assert.rejects(f.store.inspect(f.policy, runtime, 'scope'), /enrollment-changed/);
      await assert.rejects(f.store.prepare(f.input), /enrollment-changed/);
      assert.deepEqual((await f.store.read()).records, [first]);
    });
  }

  it('should inspect missing installation state without creating files', async () => {
    const store = new ProjectPickupEnrollmentStore(root);
    await assert.rejects(store.owner(), /instance-install-required/);
    assert.deepEqual(await readdir(root), []);
  });

  it('should derive one native job with runtime model routing and reject unsupported cadence', () => {
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
      policy.projectPickup!.windowMinutes = 4;
      assert.equal(projectPickupConfigurationCode(policy), 'project-pickup-schedule-unsupported');
      policy.projectPickup!.windowMinutes = 10;
    }
    assert.equal(projectPickupConfigurationCode(policy), undefined);
    const obsolete = structuredClone(source);
    Object.assign(obsolete.github['project-pickup'], {
      coordinator: { runtime: 'codex', 'instance-id': '00000000-0000-4000-8000-000000000001' },
    });
    assert.equal(parseAgentManifest(JSON.stringify(obsolete)).status, 'invalid');
  });
});
