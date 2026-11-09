import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assignmentClaimRoute } from '../agent/assignment-claim-source.ts';
import CodexAssignmentClaims from '../agent/codex-assignment-claims.ts';
import OpenClawAssignmentClaims from '../agent/openclaw-assignment-claims.ts';
import { pickupAuthority } from '../agent/issue-pickup.ts';
import { pickupIssueKey } from '../agent/issue-pickup-capacity.ts';
import IntakeRecordStore, {
  intakeLocation,
  type IntakeRecord,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import fixture from './issue-pickup-selection-fixture.ts';
import claimFixture from './issue-pickup-claim-fixture.ts';
import { baseline } from './github-intake-fixture.ts';

type Fixture = ReturnType<typeof fixture>;
type Claims = ReturnType<typeof claimFixture>;

describe('issue pickup handoff to ordinary assignment claims', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pickup-handoff-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function intake(f: Fixture, name: string) {
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: f.tx.runtime,
        root: join(root, name),
        namespace: '/profile',
        workspaceDir: f.tx.workspaceDir,
        agentId: f.tx.agentId,
      }),
    );
    f.tx.scope = f.tx.enrollment.scope = store.location.scope;
    const options = {
      runtime: f.tx.runtime,
      store,
      policy: f.policy,
      policyDigest: 'fixture',
      workspaceDir: f.tx.workspaceDir,
      agentId: f.tx.agentId,
      connect: async () => f.tx.client,
      assertCurrent: async () => {},
    };
    await scanAssignments({ ...options, now: baseline, activate: true });
    return async () => {
      await scanAssignments({
        ...options,
        now: f.clock.now,
        issuePickup: pickupAuthority(f.state.projectPickup),
      });
      return (await store.read())!.records[0]!;
    };
  }
  function elect(f: Fixture, c: Claims, admitted: IntakeRecord, pass: string) {
    const input = {
      intake: admitted,
      client: c.provider,
      hasCapacity: true,
      mode: assignmentClaimRoute(f.policy, admitted).decision,
      eligibleInstanceIds: assignmentClaimRoute(f.policy, admitted).eligibleInstanceIds,
    };
    return f.tx.runtime === 'codex'
      ? new CodexAssignmentClaims(c.store, () => c.client).select({
          ...input,
          threadId: 'intake',
          turnId: pass,
        })
      : new OpenClawAssignmentClaims(c.store, () => c.client).select({
          ...input,
          caller: { sessionKey: 'intake', sessionId: 'session', runId: pass, toolCallId: pass },
        });
  }
  function shared(a: Fixture, b: Fixture) {
    b.tx.client = a.client;
    const second = {
      ...a.item,
      nodeId: 'I_second',
      databaseId: a.item.databaseId + 1,
      number: a.item.number + 1,
    };
    a.items.set(second.number, second);
    a.candidates.set(second.number, {
      ...a.candidates.get(a.item.number)!,
      nodeId: second.nodeId,
      number: second.number,
    });
    const histories = new Map<number, typeof a.events>();
    const write = a.client.assignProjectIssue;
    a.client.assignProjectIssue = async (...args) => {
      if (a.items.get(args[2])!.assignees.length) return;
      await write(...args);
      histories.set(args[2], a.events.slice(-1));
    };
    a.client.listAssignmentEvents = async (_owner, _name, number) => ({
      events: structuredClone(histories.get(number) ?? []),
      truncated: false,
    });
    a.client.discoverAssigned = async () => ({
      candidates: [...a.items.values()]
        .filter((item) => item.assignees.length)
        .map((item) => ({
          nodeId: item.nodeId,
          databaseId: item.databaseId,
          number: item.number,
          itemType: 'issue' as const,
          updatedAt: item.updatedAt,
          repositoryPath: '/repos/owner/repo',
        })),
      incomplete: false,
      totalCount: [...a.items.values()].filter((item) => item.assignees.length).length,
      truncated: false,
    });
    return second;
  }
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should leave assignment to the eligible participant when the ${runtime} picker is excluded`, async () => {
      const a = fixture(runtime),
        b = fixture(runtime === 'codex' ? 'openclaw' : 'codex');
      shared(a, b);
      const ca = claimFixture(a, join(root, 'excluded'));
      const cb = claimFixture(b, join(root, 'eligible'), ca.comments);
      await ca.store.identity();
      const identity = await cb.store.identity();
      a.policy.routing = b.policy.routing = [
        {
          match: 'owner/*',
          workflows: ['issue-assignment'],
          target: { instances: [identity.instanceId] },
        },
        'owner/*',
      ];
      const admitA = await intake(a, 'intake-a'),
        admitB = await intake(b, 'intake-b');
      const held = await a.run();
      assert.ok('code' in held && held.code === 'claim-route-instance-ineligible');
      assert.equal(a.effects.writes, 0);
      assert.equal((await b.run({ selection: await b.select() })).status, 'assigned');
      assert.equal(ca.comments.length, 0);
      assert.equal(await admitA(), undefined);
      const admitted = await admitB();
      assert.equal(admitted.evidence.mode, 'work');
      assert.equal((await elect(b, cb, admitted, 'first')).status, 'pending');
      assert.equal((await elect(b, cb, admitted, 'second')).status, 'owned');
    });

    it(`should self-assign without publishing a claim and use ordinary routing in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.policy.routing = [{ 'owner/*': 'swarm' }];
      const c = claimFixture(f, join(root, 'claims'));
      const admit = await intake(f, 'intake');
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(c.effects.creates, 0);
      const admitted = await admit();
      assert.equal(admitted.evidence.mode, 'work');
      assert.equal((await elect(f, c, admitted, 'first')).status, 'pending');
      assert.equal((await elect(f, c, admitted, 'second')).status, 'owned');
      assert.equal(c.effects.creates, 1);
      f.policy.routing = [
        { match: 'owner/repo', workflows: ['issue-assignment'], target: 'deny' },
        'owner/*',
      ];
      assert.equal(assignmentClaimRoute(f.policy, admitted).decision, 'deny');
    });
  }

  it('should elect one intake owner and preserve the pilot allowance until the next window', async () => {
    const a = fixture('codex'),
      b = fixture('openclaw');
    a.policy.routing = b.policy.routing = [{ 'owner/*': 'swarm' }];
    const second = shared(a, b);
    const ca = claimFixture(a, join(root, 'a')),
      cb = claimFixture(b, join(root, 'b'), ca.comments);
    const admitA = await intake(a, 'intake-a'),
      admitB = await intake(b, 'intake-b');
    const selections = await Promise.all([a.select(), b.select()]);
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assign = a.client.assignProjectIssue;
    a.client.assignProjectIssue = async (...args) => {
      if (++arrivals === 2) release();
      await barrier;
      await assign(...args);
    };
    const results = await Promise.all([
      a.run({ selection: selections[0] }),
      b.run({ selection: selections[1] }),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['assigned', 'assigned'],
    );
    assert.equal(a.effects.writes, 1);
    assert.equal(ca.comments.length, 0);
    const [ia, ib] = await Promise.all([admitA(), admitB()]);
    assert.equal(ia.assignment.nodeId, ib.assignment.nodeId);
    assert.equal((await elect(a, ca, ia, 'first')).status, 'pending');
    assert.equal((await elect(b, cb, ib, 'first')).status, 'other-owner');
    assert.equal((await elect(a, ca, ia, 'second')).status, 'owned');
    for (const [f, record, request] of [
      [a, ia, {}],
      [b, ib, undefined],
    ] as const) {
      f.state.records.push({
        issueKey: pickupIssueKey(f.state.projectPickup!, record.issue.nodeId),
        projectWork: record.evidence.projectWork,
        phase: 'routing',
        ...(request ? { request } : {}),
      });
      f.tx.runId = 'next-scan';
    }
    a.policy.maxConcurrentItems = b.policy.maxConcurrentItems = 1;
    assert.equal((await a.run()).status, 'allowance-reached');
    assert.equal((await b.run()).status, 'allowance-reached');
    assert.equal(a.effects.writes, 1);
    for (const f of [a, b]) {
      f.clock.now += 86400000;
      f.tx.runId = 'next-window';
    }
    assert.equal((await a.run()).status, 'at-capacity');
    const next = await b.run();
    assert.equal(next.status, 'selection-required');
    assert.ok('digest' in next);
    assert.equal(
      (
        await b.run({
          selection: {
            issueNodeId: second.nodeId,
            rationale: 'remaining eligible work',
          },
        })
      ).status,
      'assigned',
    );
    assert.equal(a.effects.writes, 2);
    assert.equal(
      ca.effects.creates + cb.effects.creates,
      1,
      'pickup must never publish claim comments',
    );
  });

  it('should skip an issue already assigned by the other scan and allow distinct intake owners', async () => {
    const a = fixture('codex'),
      b = fixture('openclaw');
    a.policy.routing = b.policy.routing = [{ 'owner/*': 'swarm' }];
    const second = shared(a, b);
    const ca = claimFixture(a, join(root, 'a')),
      cb = claimFixture(b, join(root, 'b'), ca.comments);
    const admitA = await intake(a, 'intake-a'),
      admitB = await intake(b, 'intake-b');
    assert.equal((await a.run({ selection: await a.select() })).status, 'assigned');
    const selection = await b.run();
    assert.equal(selection.status, 'selection-required');
    assert.ok('digest' in selection);
    assert.deepEqual(
      b.state.projectPickup!.operations[0]!.candidates.map((c) => c.nodeId),
      [second.nodeId],
    );
    assert.equal(
      (
        await b.run({
          selection: {
            issueNodeId: second.nodeId,
            rationale: 'other available issue',
          },
        })
      ).status,
      'assigned',
    );
    const [ia, ib] = await Promise.all([admitA(), admitB()]);
    assert.equal(ia.evidence.mode, 'work');
    assert.equal(ib.evidence.mode, 'work');
    assert.equal(ib.issue.nodeId, second.nodeId);
    assert.equal((await elect(a, ca, ia, 'first')).status, 'pending');
    assert.equal((await elect(b, cb, ib, 'first')).status, 'pending');
    assert.equal((await elect(a, ca, ia, 'second')).status, 'owned');
    assert.equal((await elect(b, cb, ib, 'second')).status, 'owned');
    assert.equal(ca.effects.creates + cb.effects.creates, 2);
    assert.equal(a.effects.writes, 2);
  });
});
