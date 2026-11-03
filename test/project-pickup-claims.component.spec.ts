import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptAssignmentClaim,
  assignmentClaimKey,
  selectAssignmentClaim,
  resolveClaimSource,
  type ClaimSource,
} from '../agent/assignment-claim.ts';
import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import recoverAssignmentClaim from '../agent/assignment-claim-recovery.ts';
import { assignmentClaimRoute, pickupClaimSource } from '../agent/assignment-claim-source.ts';
import CodexAssignmentClaims from '../agent/codex-assignment-claims.ts';
import OpenClawAssignmentClaims from '../agent/openclaw-assignment-claims.ts';
import { pickupAuthority } from '../agent/project-pickup.ts';
import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { parseAssignmentClaim } from '../channels/github/provider/assignment-claim.ts';
import type { RepositoryRoute } from '../channels/github/repository-scope.ts';
import fixture from './project-pickup-selection-fixture.ts';
import pickupClaims from './project-pickup-claim-fixture.ts';
import { baseline } from './github-intake-fixture.ts';

describe('project pickup shared claim ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pickup-claims-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const assignedSource = (f: ReturnType<typeof fixture>): ClaimSource => ({
    owner: 'owner',
    repository: 'repo',
    repositoryNodeId: f.repository.nodeId,
    issueNodeId: f.item.nodeId,
    number: f.item.number,
    receivingNodeId: f.client.identity.nodeId,
    assignerNodeId: f.client.identity.nodeId,
    assignmentEventId: f.events[0]!.nodeId,
  });
  const dispatch = (f: ReturnType<typeof fixture>) =>
    selectAssignmentClaim({
      ...f.tx.claims,
      source: assignedSource(f),
      mode: 'swarm',
      hasCapacity: true,
      passId: 'intake-pass',
    });

  it('should carry one pre-assignment owner through intake, acceptance and exact native recovery', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    assert.equal((await f.run({ selection: await f.select() })).status, 'pending');
    assert.equal(f.effects.writes, 0);
    assert.equal((await f.run()).status, 'pending');
    f.tx.claims.passId = 'second';
    assert.equal((await f.run()).status, 'assigned');
    const expected = assignmentClaimKey(pickupClaimSource(assignedSource(f), null));
    assert.ok(await c.store.hasClaim(expected));
    assert.equal((await dispatch(f)).status, 'owned');
    await acceptAssignmentClaim({
      ...f.tx.claims,
      source: assignedSource(f),
      nativeReceipt: 'chat-one',
    });
    assert.equal(
      parseAssignmentClaim(c.comments[0]!)!.assignmentEventId,
      pickupClaimSource(assignedSource(f), null).assignmentEventId,
    );
    const store = new AssignmentClaimStore(root);
    await recoverAssignmentClaim({
      store,
      client: c.client,
      source: assignedSource(f),
      recoveryId: 'recovery',
      predecessorReceipt: 'chat-one',
      operation: 'reserve',
    });
    await recoverAssignmentClaim({
      store,
      client: c.client,
      source: assignedSource(f),
      recoveryId: 'recovery',
      predecessorReceipt: 'chat-one',
      operation: 'accept',
      successorReceipt: 'chat-two',
    });
    assert.equal(f.effects.writes, 1);
    assert.equal(c.effects.creates, 1);
    assert.equal(c.effects.updates, 1);
  });

  it('should elect once across runtimes and hold the loser before winner readback', async () => {
    const a = fixture('codex');
    const b = fixture('openclaw');
    b.tx.client = a.client;
    const ca = pickupClaims(a, join(root, 'a'));
    const cb = pickupClaims(b, join(root, 'b'), ca.comments);
    const observer = fixture();
    observer.tx.client = a.client;
    const observed = pickupClaims(observer, join(root, 'observer'), ca.comments);
    const ids = await Promise.all(
      [a, b].map(
        async (f) => (await (f.tx.claims.store as AssignmentClaimStore).identity()).instanceId,
      ),
    );
    a.policy.routing = [{ 'owner/*': ids }];
    b.policy.routing = [{ 'owner/*': [...ids].reverse() }];
    const [sa, sb] = await Promise.all([a.select(), b.select()]);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = ca.client.list;
    ca.client.list = cb.client.list = async (source) => {
      const snapshot = await list(source);
      if (++reads === 2) release();
      await barrier;
      return snapshot;
    };
    const first = await Promise.all([a.run({ selection: sa }), b.run({ selection: sb })]);
    assert.ok(first.every((result) => result.status === 'pending'));
    ca.client.list = cb.client.list = list;
    const winner = parseAssignmentClaim(ca.comments[0]!)!.instanceId === ids[0] ? a : b;
    const loser = winner === a ? b : a;
    winner.tx.claims.passId = loser.tx.claims.passId = 'second';
    const write = a.client.assignProjectIssue;
    a.client.assignProjectIssue = async (...args) => {
      await write(...args);
      assert.equal((await loser.run()).status, 'discovering');
      assert.equal(
        (
          await selectAssignmentClaim({
            ...observer.tx.claims,
            source: assignedSource(a),
            mode: 'swarm',
            hasCapacity: true,
          })
        ).status,
        'other-owner',
      );
      throw new Error('assignment-response-lost');
    };
    assert.equal((await winner.run()).status, 'attempted');
    winner.tx.claims.store = new AssignmentClaimStore(join(root, winner === a ? 'a' : 'b'));
    winner.tx.claims.passId = 'restart';
    assert.equal((await winner.run()).status, 'assigned');
    assert.equal(a.effects.writes, 1);
    assert.equal(ca.comments.length, 1);
    assert.equal(ca.effects.creates + cb.effects.creates, 2);
    assert.equal(observed.effects.creates, 0);
    assert.equal(loser.state.projectPickup!.operations[0]!.receipt, undefined);
  });

  it('should consider another candidate in the same window after losing a shared claim', async () => {
    const a = fixture('codex');
    const b = fixture('openclaw');
    b.tx.client = a.client;
    a.policy.routing = b.policy.routing = [{ 'owner/*': 'swarm' }];
    const ca = pickupClaims(a, join(root, 'winner'));
    const cb = pickupClaims(b, join(root, 'loser'), ca.comments);
    const histories = new Map<number, typeof a.events>();
    a.client.listAssignmentEvents = async (_owner, _name, number) => ({
      events: structuredClone(histories.get(number) ?? []),
      truncated: false,
    });
    const assign = a.client.assignProjectIssue;
    a.client.assignProjectIssue = async (...args) => {
      await assign(...args);
      histories.set(args[2], a.events.slice(-1));
    };
    const second = { ...a.item, nodeId: 'I_second', number: a.item.number + 1 };
    ca.client.list = cb.client.list = async (source) =>
      structuredClone(
        source.number === a.item.number ? ca.comments.slice(0, 1) : ca.comments.slice(1),
      );
    a.items.set(second.number, second);
    a.candidates.set(second.number, {
      ...a.candidates.get(a.item.number)!,
      nodeId: second.nodeId,
      number: second.number,
    });
    assert.equal((await a.run({ selection: await a.select() })).status, 'pending');
    assert.equal((await b.run({ selection: await b.select() })).status, 'discovering');
    const sameWindow = b.state.projectPickup!.operations[0]!.window.id;
    const next = await b.run();
    assert.equal(next.status, 'selection-required');
    assert.ok('digest' in next);
    assert.deepEqual(
      b.state.projectPickup!.operations[0]!.candidates.map((item) => item.nodeId),
      [second.nodeId],
    );
    assert.equal(
      (
        await b.run({
          selection: {
            id: next.id!,
            digest: next.digest!,
            issueNodeId: second.nodeId,
            rationale: 'other eligible work',
          },
        })
      ).status,
      'pending',
    );
    // Each issue has its own provider comment history.
    ca.client.list = async () => structuredClone(ca.comments.slice(0, 1));
    cb.client.list = async () => structuredClone(ca.comments.slice(1));
    a.tx.claims.passId = b.tx.claims.passId = 'second';
    assert.equal((await a.run()).status, 'assigned');
    assert.equal((await b.run()).status, 'assigned');
    assert.equal(a.effects.writes, 2);
    assert.equal(b.state.projectPickup!.operations.length, 1);
    assert.equal(b.state.projectPickup!.operations[0]!.window.id, sameWindow);
    assert.equal(b.state.projectPickup!.operations[0]!.receipt!.issueNodeId, second.nodeId);
    assert.equal(ca.effects.removes + cb.effects.removes, 0);
  });

  it('should refuse non-target, exclusion and no-match before reservation without fallthrough', async () => {
    const routes: RepositoryRoute[][] = [
      [{ 'owner/*': '11111111-1111-4111-8111-111111111111' }, '*/*'],
      ['!owner/*', '*/*'],
      ['elsewhere/*'],
    ];
    for (const [i, routing] of routes.entries()) {
      const f = fixture();
      const c = pickupClaims(f, join(root, String(i)));
      await (c.store as AssignmentClaimStore).identity();
      f.policy.routing = routing;
      const result = await f.run();
      assert.equal(result.status, 'pending');
      assert.equal(f.state.projectPickup!.operations.length, 0);
      assert.equal(f.effects.writes, 0);
      assert.equal(c.effects.creates, 0);
    }
  });

  it('should honor a singleton route and capacity without borrowing another target', async () => {
    const f = fixture();
    f.policy.maxConcurrentItems = 1;
    const c = pickupClaims(f, root);
    const id = (await (c.store as AssignmentClaimStore).identity()).instanceId;
    f.policy.routing = [{ 'owner/*': id }];
    f.state.records.push({ issueKey: 'occupied', phase: 'running', request: {} });
    assert.equal((await f.run()).status, 'at-capacity');
    assert.equal(c.effects.creates, 0);
    f.state.records = [];
    assert.equal((await f.run({ selection: await f.select() })).status, 'pending');
    f.tx.claims.passId = 'second';
    assert.equal((await f.run()).status, 'assigned');
  });

  it('should reconcile uncertain publication after restart without publishing again', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    c.effects.responseLost = true;
    const result = await f.run({ selection: await f.select() });
    assert.equal(result.status, 'reserved');
    assert.ok('code' in result && result.code === 'project-pickup-provider-unavailable');
    f.tx.claims.store = new AssignmentClaimStore(root);
    f.tx.claims.passId = 'restart';
    assert.equal((await f.run()).status, 'assigned');
    assert.equal(c.effects.creates, 1);
    assert.equal(f.effects.writes, 1);
  });

  it('should hold missing ownership through assignment intake without a fresh election', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    await f.run({ selection: await f.select() });
    f.tx.claims.passId = 'second';
    await f.run();
    c.comments.length = 0;
    const result = await dispatch(f);
    assert.equal(result.code, 'claim-winner-missing');
    assert.equal(c.effects.creates, 1);
    assert.equal(f.effects.writes, 1);
  });

  it('should preserve a pending owner across pool edits and a lost assignment response', async () => {
    const f = fixture();
    const c = pickupClaims(f, root);
    const id = (await (c.store as AssignmentClaimStore).identity()).instanceId;
    const other = '11111111-1111-4111-8111-111111111111';
    f.policy.routing = [{ 'owner/*': id }];
    await f.run({ selection: await f.select() });
    f.policy.routing = [{ 'owner/*': other }];
    f.tx.claims.passId = 'second';
    const held = await f.run();
    assert.ok('code' in held && held.code === 'claim-route-owner-ineligible');
    assert.equal(f.effects.writes, 0);
    f.policy.routing = [{ 'owner/*': id }];
    const write = f.client.assignProjectIssue;
    f.client.assignProjectIssue = async (...args) => {
      await write(...args);
      throw new Error('lost');
    };
    assert.equal((await f.run()).status, 'attempted');
    f.policy.routing = [{ 'owner/*': other }];
    assert.equal((await f.run()).status, 'assigned');
    assert.equal(f.effects.writes, 1);
    assert.equal(c.effects.creates, 1);
  });

  it('should hold local conflicts, incomplete history and damaged metadata without assigning', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    await f.run({ selection: await f.select() });
    const local = fixture();
    pickupClaims(local, join(root, 'local'), c.comments);
    const result = await local.run({ selection: await local.select() });
    assert.ok('code' in result && result.code === 'claim-route-conflict');
    f.tx.claims.passId = 'second';
    c.comments[0]!.body = c.comments[0]!.body.replace('claim:v1', 'claim:v99');
    assert.equal((await f.run()).status, 'recovery-required');
    f.client.listAssignmentEvents = async () => ({ events: [], truncated: true });
    assert.equal((await f.run()).status, 'failed');
    assert.equal(f.effects.writes + local.effects.writes, 0);
  });

  it('should recheck candidate evidence after the final ownership observation', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    await f.run({ selection: await f.select() });
    f.tx.claims.passId = 'second';
    const verify = c.client.verify.bind(c.client);
    c.client.verify = async (source) => {
      await verify(source);
      f.candidates.get(f.item.number)!.body = 'changed during claim observation';
    };
    assert.equal((await f.run()).status, 'failed');
    assert.equal(f.effects.writes, 0);
  });

  it('should preserve ordinary assignment keys when there is no pickup claim', async () => {
    const f = fixture();
    const c = pickupClaims(f, root);
    await f.run({ selection: await f.select() });
    const source = assignedSource(f);
    assert.deepEqual(await resolveClaimSource(c.store, c.client, source), source);
    const external = { ...source, assignerNodeId: 'U_operator' };
    f.events[0]!.actor = { login: 'operator', nodeId: 'U_operator', type: 'User' };
    assert.deepEqual(await resolveClaimSource(c.store, c.client, external), external);
    assert.equal(c.effects.creates, 0);
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should retain the ${runtime} pickup owner across different assignment routes`, async () => {
      const f = fixture(runtime);
      const c = pickupClaims(f, join(root, 'owner'));
      const observer = pickupClaims(fixture(runtime), join(root, 'observer'), c.comments);
      const observerStore = observer.store as AssignmentClaimStore;
      const other = (await observerStore.identity()).instanceId;
      const assignmentRoute = {
        id: 'assignments',
        match: 'owner/repo',
        workflows: ['issue-assignment'] as ['issue-assignment'],
        target: 'deny' as const,
      };
      f.policy.routing = [assignmentRoute, { 'owner/*': 'swarm' }];
      const store = new IntakeRecordStore(
        intakeLocation({
          runtime,
          root: join(root, 'intake'),
          namespace: '/profile',
          workspaceDir: f.tx.workspaceDir,
          agentId: f.tx.agentId,
        }),
      );
      f.tx.enrollment.scope = f.tx.scope = store.location.scope;
      const scan = {
        runtime,
        store,
        policy: f.policy,
        policyDigest: 'policy',
        workspaceDir: f.tx.workspaceDir,
        agentId: f.tx.agentId,
        now: baseline,
        connect: async () => f.client,
        assertCurrent: async () => {},
      };
      await scanAssignments({ ...scan, activate: true });
      await f.run({ selection: await f.select() });
      f.tx.claims.passId = 'second';
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost response');
      };
      assert.equal((await f.run()).status, 'attempted');
      assert.equal((await scanAssignments({ ...scan, now: f.clock.now })).admitted, 0);
      const restarted = new AssignmentClaimStore(join(root, 'owner'));
      f.tx.claims.store = restarted;
      assert.equal((await f.run()).status, 'assigned');
      assert.equal(
        (
          await scanAssignments({
            ...scan,
            now: f.clock.now,
            readProjectPickup: async () => pickupAuthority(f.state.projectPickup),
          })
        ).admitted,
        1,
      );
      const intake = (await store.read())!.records[0]!;
      const winnerId = intake.evidence.projectWork!.pickup!.claimCommentId;
      assert.equal(winnerId, c.comments[0]!.databaseId);
      assert.equal(intake.evidence.repositoryScope?.ruleId, 'assignments');
      const route = assignmentClaimRoute(f.policy, intake);
      const select = (
        store: AssignmentClaimStore,
        mode: 'local' | 'swarm' | 'deny',
        admitted = intake,
        pool?: string[],
      ) => {
        const client = c.provider;
        const input = {
          intake: admitted,
          client,
          mode,
          eligibleInstanceIds: pool,
          hasCapacity: true,
        };
        return runtime === 'codex'
          ? new CodexAssignmentClaims(store, () => c.client).select({
              ...input,
              threadId: 'thread',
              turnId: 'turn',
            })
          : new OpenClawAssignmentClaims(store, () => c.client).select({
              ...input,
              caller: { sessionKey: 'key', sessionId: 'session', runId: 'run', toolCallId: 'tool' },
            });
      };
      const recovered = await select(restarted, route.decision);
      assert.equal(recovered.status, 'owned');
      assert.equal(recovered.winnerId, winnerId);
      const ordinary = { ...intake, evidence: { ...intake.evidence, projectWork: undefined } };
      const uninstalled = new AssignmentClaimStore(join(root, 'uninstalled'));
      await assert.rejects(select(uninstalled, 'local', ordinary), /instance-install-required/);
      assert.equal(await uninstalled.inspect(), undefined);
      for (const target of ['local', { instance: other }] as const) {
        f.policy.routing![0] = { ...assignmentRoute, target };
        const observerRoute = assignmentClaimRoute(f.policy, ordinary);
        const decision = await select(
          observerStore,
          observerRoute.decision,
          ordinary,
          observerRoute.eligibleInstanceIds,
        );
        assert.equal(decision.status, 'other-owner');
        assert.equal(decision.winnerId, winnerId);
      }
      c.comments.splice(0);
      const missing = await select(restarted, route.decision);
      assert.equal(missing.status, 'recovery-required');
      assert.equal(missing.code, 'claim-winner-missing');
      assert.equal(f.effects.writes, 1);
      assert.equal(c.effects.creates, 1);
    });
  }

  it('should bind claims to prior assignment history and reject a changed baseline', async () => {
    const f = fixture();
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    f.events.push({
      actor: f.client.identity,
      assignee: f.client.identity,
      event: 'unassigned',
      nodeId: 'E_old',
      databaseId: 50,
      createdAt: new Date(f.clock.now - 1000).toISOString(),
    });
    await f.run({ selection: await f.select() });
    assert.equal(f.state.projectPickup!.operations[0]!.claim!.previousEventId, 'E_old');
    f.events.push({
      ...f.events[0]!,
      nodeId: 'E_changed',
      databaseId: 51,
      createdAt: new Date(f.clock.now).toISOString(),
    });
    f.tx.claims.passId = 'second';
    const result = await f.run();
    assert.ok('code' in result && result.code === 'claim-assignment-changed');
    assert.equal(c.effects.creates, 1);
    assert.equal(f.effects.writes, 0);
  });

  it('should preserve pending ownership through capacity loss and window expiry', async () => {
    const f = fixture();
    f.policy.maxConcurrentItems = 1;
    f.policy.routing = [{ 'owner/*': 'swarm' }];
    const c = pickupClaims(f, root);
    await f.run({ selection: await f.select() });
    f.tx.claims.passId = 'second';
    f.state.records.push({ issueKey: 'occupied', phase: 'running', request: {} });
    assert.equal((await f.run()).status, 'at-capacity');
    f.clock.now += 3600000;
    await f.run();
    assert.equal(f.state.projectPickup!.operations[0]!.phase, 'expired');
    assert.equal(f.effects.writes, 0);
    assert.equal(c.comments.length, 1);
    f.state.records = [];
    f.clock.now += 23 * 3600000;
    f.tx.claims.passId = 'next-window';
    assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    assert.equal(c.effects.creates, 1);
    assert.equal(f.effects.writes, 1);
  });
});
