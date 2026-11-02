import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import ProjectPickupEnrollmentStore from '../agent/project-pickup-enrollment.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexCapacity from '../agent/codex-capacity.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import {
  prepareCodexPickupEnrollment,
  runCodexIntake,
  runCodexProjectPickup,
  selectCodexIntake,
  type CodexIntakeDependencies,
} from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import { projectPickupPolicyDigest } from '../agent/project-pickup-authority.ts';
import type { PickupInput } from '../agent/project-pickup.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { baseline } from './github-intake-fixture.ts';
import selectionFixture from './project-pickup-selection-fixture.ts';

describe('project pickup selection through native journals', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pickup-selection-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(runtime: 'codex' | 'openclaw') {
    const f = selectionFixture(runtime);
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    const home = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(home);
    const instanceRoot = join(data, 'instance');
    const identity = await new AssignmentClaimStore(instanceRoot).identity();
    const enrollmentStore = new ProjectPickupEnrollmentStore(instanceRoot);
    const caller = { current: true };
    const tick = { id: 'pickup-turn-1' };
    const assertCurrent = async () => {
      if (!caller.current) throw new Error('project-pickup-native-caller-required');
    };
    const occurrence = {
      nativeId: 'pickup-job',
      get runId() {
        return tick.id;
      },
      assertCurrent,
    };

    const source = JSON.stringify({
      'schema-version': 1,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        runtimes: [runtime],
        'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
        'max-concurrent-items': 1,
        'issue-assignment': {
          mode: 'plan',
          allowed: [
            { login: 'operator', 'node-id': 'U_operator' },
            { login: 'receiver', 'node-id': 'U_receiver' },
          ],
        },
        'project-pickup': {
          coordinator: { runtime, 'instance-id': identity.instanceId },
          schedule: 'every 1 day',
          'window-minutes': 60,
          selection: { guidance: { file: 'selection.md' } },
          projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' } }],
        },
      },
    });
    await writeFile(join(workspace, 'agent.yaml'), source);
    await writeFile(join(workspace, 'selection.md'), 'prefer high impact ready work');
    const parsed = parseAgentManifest(source);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') throw new Error('fixture invalid');
    const manifest = parsed.manifest;
    f.clock.now = baseline;
    let pickup: (input?: PickupInput) => ReturnType<typeof runCodexProjectPickup>;
    let scan: () => Promise<unknown>;
    let read: () => Promise<IntakeRecord[]>;
    let journal: CodexDispatchStore | OpenClawDispatchStore;
    let scope: string;
    if (runtime === 'codex') {
      await bindCodexWorkspace(data, workspace);
      const deps: CodexIntakeDependencies = {
        codexHome: home,
        now: () => f.clock.now,
        assertActive: async () => {},
        connect: async () => f.client,
        threadId: 'pickup-thread',
        pickupActivation: async () => ({ threadId: 'pickup-thread', nativeId: 'pickup-job' }),
        intakeNative: {
          occurrence: async () => {
            await assertCurrent();
            return {
              id: tick.id,
              automationId: 'pickup-job',
              currentTimeIso: new Date(f.clock.now).toISOString(),
            };
          },
        },
      };
      await runCodexIntake(data, true, deps);
      const selected = await selectCodexIntake(data, deps);
      scope = selected.store.location.scope;
      journal = new CodexDispatchStore(data, scope);
      const enrollment = await prepareCodexPickupEnrollment(data, deps);
      await enrollmentStore.activate(enrollment.enrollment.id, occurrence.nativeId);
      Object.assign(f.authority.enrollment, enrollment.enrollment);
      pickup = (input = {}) => runCodexProjectPickup(data, input, 'UTC', deps);
      scan = () => runCodexIntake(data, false, deps);
      read = async () => (await selected.store.read())!.records;
    } else {
      const intake = new OpenClawIntake({
        root: data,
        pickupStore: enrollmentStore,
        namespace: root,
        now: () => f.clock.now,
        readiness: async () => undefined,
        connect: async () => f.client,
        manifestService: {
          loadForAgentId: async () => ({
            status: 'loaded',
            manifest,
            scope: { workspaceDir: workspace, agentId: 'receiver' },
            path: join(workspace, 'agent.yaml'),
            digest: 'fixture',
            diagnostics: [],
            validationChecks: [],
          }),
        },
      });
      await intake.run(manifest, workspace, 'activate');
      const selected = await intake.select(manifest, workspace);
      scope = selected.store.location.scope;
      journal = new OpenClawDispatchStore(data, scope);
      const enrollment = await intake.preparePickup(manifest, workspace);
      await enrollmentStore.activate(enrollment.enrollment.id, occurrence.nativeId);
      Object.assign(f.authority.enrollment, enrollment.enrollment);
      pickup = (input = {}) => intake.pickup(manifest, workspace, input, 'UTC', occurrence);
      scan = () => intake.run(manifest, workspace, 'scan');
      read = async () => (await selected.store.read())!.records;
    }
    Object.assign(f.authority.enrollment, {
      scope,
      workspaceDir: workspace,
      policyDigest: projectPickupPolicyDigest(manifest.github!.notifications!),
    });
    f.clock.now += 60000;
    const select = async () => {
      const result = await pickup();
      assert.equal(result.status, 'selection-required');
      assert.ok('digest' in result);
      return {
        id: result.id!,
        digest: result.digest!,
        issueNodeId: f.item.nodeId,
        rationale: 'highest explicit priority and impact among ready work',
      };
    };
    return { ...f, pickup, scan, read, journal, select, caller, tick };
  }

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should keep empty ticks quiet and report the window close once through ${runtime}`, async () => {
      const f = await fixture(runtime);
      f.candidates.clear();
      const empty = await f.pickup();
      assert.equal(empty.status, 'empty');
      if (runtime === 'codex') assert.match(empty.response, /<decision>DONT_NOTIFY<\/decision>/);
      else assert.equal(empty.response, '');
      f.tick.id = 'pickup-empty-2';
      const quiet = await f.pickup();
      assert.doesNotMatch(quiet.response, /> ##/);
      f.clock.now += 7200000;
      f.tick.id = 'pickup-empty-closed';
      const closed = await f.pickup();
      assert.match(closed.response, /Pickup window summary/);
      assert.match(closed.response, /does not mean completion/);
      f.tick.id = 'pickup-empty-closed-2';
      assert.doesNotMatch((await f.pickup()).response, /> ##/);
      assert.equal(f.effects.writes, 0);
    });

    it(`should retain selected, quiet, blocked and recovery cards through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('lost response');
      };
      const blocked = await f.pickup({ selection });
      assert.equal(blocked.status, 'attempted');
      assert.match(blocked.response, /> ## ⚠️/);
      assert.match(blocked.response, /`project-pickup-assignment-uncertain`/);
      assert.ok(blocked.response.includes((await f.journal.read()).projectPickupReport!.response));
      const replay = await f.pickup();
      assert.equal(replay.response, blocked.response);
      f.tick.id = 'pickup-turn-2';
      const selected = await f.pickup();
      assert.equal(selected.status, 'assigned');
      assert.match(selected.response, /Project pickup resumed/);
      assert.match(selected.response, /github\.com\/owner\/repo\/milestone\/10/);
      assert.match(selected.response, /Why selected/);
      f.tick.id = 'pickup-turn-3';
      const quiet = await f.pickup();
      if (runtime === 'codex') assert.match(quiet.response, /<decision>DONT_NOTIFY<\/decision>/);
      else assert.equal(quiet.response, '');
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.journal.read()).projectPickupReport!.notify, false);
    });

    it(`should reject an expired native occurrence before provider assignment in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      f.caller.current = false;
      await assert.rejects(f.pickup({ selection }), /native-caller-required/);
      assert.equal(f.effects.writes, 0);
    });

    it(`should persist selection and uncertain assignment then admit once after restart in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const before = await f.journal.read();
      assert.equal(before.projectPickup!.operations[0]!.guidance, 'prefer high impact ready work');
      assert.equal(before.projectPickup!.operations[0]!.phase, 'selecting');
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost response');
      };
      assert.equal((await f.pickup({ selection })).status, 'attempted');
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.phase, 'attempted');
      f.clock.now += 7200000;
      assert.equal((await f.pickup()).status, 'assigned');
      await f.scan();
      await f.scan();
      const records = await f.read();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.evidence.mode, 'work');
      assert.equal(records[0]!.evidence.projectWork!.pickup!.assignmentNodeId, f.events[0]!.nodeId);
      assert.equal(f.effects.writes, 1);
      const state = await f.journal.read();
      const capacity =
        runtime === 'codex'
          ? codexCapacity([], 1, state.projectPickup)
          : openClawCapacity([], 1, state.projectPickup);
      assert.deepEqual(capacity, { occupied: 1, available: 0 });
    });

    it(`should withhold an uncertain self-assignment even when the actor is approved in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost response');
      };
      await f.pickup({ selection });
      await f.scan();
      assert.equal((await f.read()).length, 0);
      await f.pickup();
      await f.scan();
      assert.equal((await f.read()).length, 1);
    });

    it(`should serialize concurrent ticks and preserve cancellation in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const results = await Promise.allSettled([f.pickup({ selection }), f.pickup({ selection })]);
      assert.ok(
        results.some(
          (result) => result.status === 'fulfilled' && result.value.status === 'assigned',
        ),
      );
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.journal.read()).projectPickup!.operations.length, 1);
      assert.equal((await f.pickup({ cancel: selection.id })).status, 'cancelled');
      await f.scan();
      assert.equal((await f.read()).length, 0);
      assert.equal((await f.pickup()).status, 'idle');
    });

    it(`should refuse competing ownership between pickup and native admission in ${runtime}`, async () => {
      const f = await fixture(runtime);
      await f.pickup({ selection: await f.select() });
      f.item.assignees.push({ login: 'other', nodeId: 'U_other', type: 'User' });
      await f.scan();
      assert.equal((await f.read()).length, 0);
      assert.equal(f.item.assignees.length, 2);
    });
  }
});
