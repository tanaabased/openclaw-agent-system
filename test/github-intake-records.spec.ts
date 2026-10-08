import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('channels/github/intake/records', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intake-records-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function setup(runtime: 'codex' | 'openclaw' = 'codex') {
    const fixture = intakeFixture();
    const location = intakeLocation({
      runtime,
      root,
      namespace: '/profile',
      workspaceDir: '/workspace',
      agentId: 'receiver',
    });
    const store = new IntakeRecordStore(location);
    return {
      ...fixture,
      store,
      input: {
        store,
        policy: fixture.policy,
        policyDigest: 'approved-policy',
        workspaceDir: '/workspace',
        agentId: 'receiver',
        now: baseline,
        connect: async () => fixture.client,
        assertCurrent: async () => {},
      },
    };
  }
  it('should require activation and persist one immutable record across polls and restart for both host mappings', async () => {
    for (const runtime of ['codex', 'openclaw'] as const) {
      const { input, store, events } = setup(runtime);
      await assert.rejects(scanAssignments(input), { code: 'intake-activation-required' });
      const future = events[0]!.createdAt;
      events[0]!.createdAt = new Date(baseline - 1000).toISOString();
      await scanAssignments({ ...input, activate: true });
      assert.equal((await store.read())!.records.length, 0);
      events[0]!.createdAt = future;
      const accepted = await scanAssignments({ ...input, now: baseline + 120_000 });
      assert.equal(accepted.admitted, 1);
      const state = (await store.read())!;
      assert.equal(state.records[0]!.assignment.nodeId, 'E_assignment');
      assert.equal(state.records[0]!.assignment.actor.nodeId, 'U_receiver');
      assert.equal(state.records[0]!.requiresRevalidation, true);
      assert.equal(state.records[0]!.evidence.mode, 'plan');
      const restarted = new IntakeRecordStore(store.location);
      const repeated = await scanAssignments({
        ...input,
        store: restarted,
        now: baseline + 180_000,
      });
      assert.equal(repeated.changed, false);
      assert.equal((await restarted.read())!.records.length, 1);
      assert.equal((await restarted.read())!.baselineAt, baseline);
    }
  });
  it('should reject unauthorized actors, owner pin mismatches, closed and unassigned issues, bots, and old events', async () => {
    const cases = [
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.actor = { login: 'stranger', nodeId: 'U_stranger', type: 'User' };
      },
      (f: ReturnType<typeof setup>) => {
        f.repository.owner = { login: 'owner', nodeId: 'O_other', type: 'Organization' };
      },
      (f: ReturnType<typeof setup>) => {
        f.item.state = 'closed';
      },
      (f: ReturnType<typeof setup>) => {
        f.item.assignees = [];
      },
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.actor = { ...f.events[0]!.actor, type: 'Bot' };
      },
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.createdAt = new Date(baseline).toISOString();
      },
      (f: ReturnType<typeof setup>) => {
        f.events.push({
          ...f.events[0]!,
          event: 'unassigned',
          databaseId: 31,
          nodeId: 'E_removed',
        });
      },
    ];
    for (const change of cases) {
      const fixture = setup();
      change(fixture);
      await scanAssignments({ ...fixture.input, activate: true });
      assert.equal((await fixture.store.read())!.records.length, 0);
    }
  });
  it('should retain the checkpoint on partial scans and suppress unchanged blockers', async () => {
    const { input, client, store, events } = setup();
    events[0]!.createdAt = new Date(baseline - 1).toISOString();
    await scanAssignments({ ...input, activate: true });
    client.listAssignmentEvents = async () => ({ events, truncated: true });
    const failure = await scanAssignments({ ...input, now: baseline + 10_000 });
    assert.equal(failure.code, 'intake-assignment-history-incomplete');
    assert.equal(failure.changed, true);
    assert.equal((await store.read())!.checkpoint, baseline);
    assert.equal((await scanAssignments({ ...input, now: baseline + 11_000 })).changed, false);
    client.listAssignmentEvents = async () => ({ events, truncated: false });
    assert.equal((await scanAssignments({ ...input, now: baseline + 400_000 })).changed, true);
    assert.equal((await store.read())!.blocker, undefined);
  });
  it('should serialize overlapping store instances and refuse commits after policy changes', async () => {
    const { input, store, events } = setup();
    events[0]!.createdAt = new Date(baseline - 1).toISOString();
    await scanAssignments({ ...input, activate: true });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scanAssignments({
      ...input,
      now: baseline + 1000,
      assertCurrent: async () => {
        entered();
        await gate;
      },
    });
    await ready;
    await assert.rejects(
      scanAssignments({ ...input, store: new IntakeRecordStore(store.location) }),
      { code: 'private-state-file-lock-busy' },
    );
    release();
    await first;
    const before = (await store.read())!.checkpoint;
    const failed = await scanAssignments({
      ...input,
      now: baseline + 2000,
      assertCurrent: async () => {
        throw new Error('changed');
      },
    });
    assert.equal(failed.status, 'blocked');
    assert.equal((await store.read())!.checkpoint, before);
  });
  it('should preserve corrupt evidence and reject identity or policy changes', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    await assert.rejects(scanAssignments({ ...input, policyDigest: 'unapproved' }), {
      code: 'intake-policy-reconciliation-required',
    });
    await writeFile(store.location.path, '{broken', { mode: 0o600 });
    await assert.rejects(scanAssignments(input), { code: 'intake-state-invalid' });
    assert.equal(await readFile(store.location.path, 'utf8'), '{broken');
  });
});
