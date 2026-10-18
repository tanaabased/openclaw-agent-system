import DiscoveryBudget from '../agent/discovery-budget.ts';
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
  it('should admit only the selected issue without searching or advancing the global checkpoint', async () => {
    const { input, store, client, item, events } = setup('openclaw');
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    const checkpoint = (await store.read())!.checkpoint;
    const fetched: number[] = [];
    client.discoverAssigned = async () => {
      throw Error('targeted intake must not search');
    };
    client.getItem = async (owner, repo, number) => {
      assert.equal(owner, 'owner');
      assert.equal(repo, 'repo');
      fetched.push(number);
      return { ...item, number, nodeId: `I_${number}`, databaseId: number };
    };
    for (const number of [3, 4]) {
      const result = await scanAssignments({
        ...input,
        now: baseline + 120000,
        selector: { itemType: 'issue', repository: 'owner/repo', number },
      });
      assert.equal(result.admitted, 1);
      assert.deepEqual(
        (await store.read())!.records.map((record) => record.issue.number),
        number === 3 ? [3] : [3, 4],
      );
      assert.equal((await store.read())!.checkpoint, checkpoint);
    }
    assert.deepEqual(fetched, [3, 4]);
  });

  it('should still require assignment, actor and owner authorization for selected intake', async () => {
    const { input, store, client, item, events, repository } = setup('openclaw');
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    client.discoverAssigned = async () => {
      throw Error('targeted intake must not search');
    };
    const selected = {
      ...input,
      now: baseline + 120000,
      selector: { itemType: 'issue' as const, repository: 'owner/repo', number: 3 },
    };
    const assignees = item.assignees;
    item.assignees = [];
    assert.equal((await scanAssignments(selected)).admitted, 0);
    item.assignees = assignees;
    const actor = events[0]!.actor;
    events[0]!.actor = { ...actor, nodeId: 'unapproved' };
    assert.equal((await scanAssignments(selected)).admitted, 0);
    events[0]!.actor = actor;
    repository.owner = { ...repository.owner, nodeId: 'unpinned' };
    assert.equal((await scanAssignments(selected)).admitted, 0);
    assert.deepEqual((await store.read())!.records, []);
  });

  it('should preserve a filesystem denial during scan persistence without recording a provider failure', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    const before = await store.read();
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      store.file.write = async () => {
        throw denial;
      };
      await assert.rejects(
        scanAssignments({ ...input, now: baseline + 120000 }),
        (error: unknown) => error === denial,
      );
      assert.deepEqual(await store.read(), before);
    }
  });
  it('should resume completed assignment observations after its budget expires', async () => {
    const { input, store, client, events } = setup('openclaw');
    const assignments = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assignments);
    let clock = 0;
    let reads = 0;
    const read = client.getRepository;
    client.getRepository = async (...args) => {
      reads++;
      clock = 20000;
      return read(...args);
    };
    const partial = await scanAssignments({
      ...input,
      now: baseline + 120000,
      budget: new DiscoveryBudget(20000, undefined, () => clock),
    });
    assert.equal(partial.more, true);
    assert.equal(partial.status, 'ready');
    const saved = (await store.read())!;
    assert.equal(saved.baselineAt, baseline);
    assert.equal(saved.records.length, 0);
    assert.ok(saved.discovery?.observations?.repository);
    clock = 0;
    const complete = await scanAssignments({
      ...input,
      store: new IntakeRecordStore(store.location),
      now: baseline + 240000,
      budget: new DiscoveryBudget(20000, undefined, () => clock),
    });
    assert.equal(complete.admitted, 1);
    assert.equal(reads, 1);
    assert.equal((await store.read())!.records.length, 1);
  });

  it('should propagate local save failures without inventing a provider outage', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    const before = await store.read();
    const failure = new Error('local persistence failed');
    let writes = 0;
    store.file.write = async () => {
      writes++;
      throw failure;
    };
    await assert.rejects(scanAssignments(input), (error: unknown) => error === failure);
    assert.equal(writes, 1);
    assert.deepEqual(await store.read(), before);
  });
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
      assert.ok('admitted' in accepted);
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
