import codexStorageLocation from '../agent/storage/codex-storage.ts';
import { bindSqliteInstallation } from '../agent/storage/agent-database.ts';
import { bindInstanceStore } from '../agent/storage/pickup-backend.ts';
import recoverAssignmentClaim from '../agent/tasks/dispatch/assignment-claim-recovery.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptAssignmentClaim,
  assignmentClaimKey,
  claimManualAssignment,
  selectAssignmentClaim,
  claimAssignment,
  type ClaimClient,
  type ClaimSource,
} from '../agent/tasks/dispatch/assignment-claim.ts';
import AssignmentClaimStore from '../agent/tasks/dispatch/assignment-claim-store.ts';
import { claimBody, parseAssignmentClaim } from '../channels/github/provider/assignment-claim.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';

const source: ClaimSource = {
  owner: 'owner',
  repository: 'repo',
  repositoryNodeId: 'R_repo',
  issueNodeId: 'I_issue',
  number: 1,
  receivingNodeId: 'U_receiver',
  assignmentEventId: 'E_assignment',
  assignerNodeId: 'U_actor',
};

describe('agent/assignment-claim', () => {
  let root: string;
  let stores: AssignmentClaimStore[];
  let comments: GitHubCanonicalIssueComment[];
  let writes: number;
  let deletionFails: boolean;
  let responseLost: boolean;
  let client: ClaimClient;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'assignment-claim-'));
    stores = ['a', 'b'].map((name) => new AssignmentClaimStore(join(root, name)));
    comments = [];
    writes = 0;
    deletionFails = false;
    responseLost = false;
    client = {
      async verify() {},
      async list() {
        return structuredClone(comments);
      },
      async create(_source, body) {
        const id = ++writes;
        comments.push({
          author: { nodeId: source.receivingNodeId, login: 'receiver', type: 'User' },
          body,
          bodyTruncated: false,
          databaseId: id,
          nodeId: `C_${id}`,
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T00:00:00Z',
        });
        if (responseLost) throw new Error('lost-response');
        return id;
      },
      async update(_source, id, previous, body) {
        const comment = comments.find((entry) => entry.databaseId === id)!;
        assert.equal(comment.body, previous);
        comment.body = body;
      },
      async remove(_source, id, previous) {
        if (deletionFails) throw new Error('cleanup-failed');
        assert.equal(comments.find((entry) => entry.databaseId === id)!.body, previous);
        comments = comments.filter((entry) => entry.databaseId !== id);
      },
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const local = (index = 0) =>
    selectAssignmentClaim({
      store: stores[index]!,
      client,
      source,
      passId: 'local',
      hasCapacity: true,
      mode: 'local',
    });

  it('should consume manual work immediately through the existing claim and leave other installations waiting', async () => {
    const first = await claimManualAssignment({
      store: stores[0]!,
      client,
      source,
      requestId: 'manual',
    });
    assert.equal(first.status, 'handled');
    assert.equal(writes, 1);
    assert.equal((await pass(1, 'automatic')).status, 'other-owner');
    await claimManualAssignment({ store: stores[0]!, client, source, requestId: 'second-manual' });
    assert.equal(writes, 1);
  });

  it('should preserve an automatic claimant when an operator launches elsewhere', async () => {
    await pass(1, 'automatic');
    const before = structuredClone(comments);
    const result = await claimManualAssignment({
      store: stores[0]!,
      client,
      source,
      requestId: 'manual',
    });
    assert.equal(result.status, 'handled');
    assert.deepEqual(comments, before);
    assert.equal(writes, 1);
  });

  it('should reconcile a lost manual claim response from provider evidence without another post', async () => {
    responseLost = true;
    await assert.rejects(
      claimManualAssignment({ store: stores[0]!, client, source, requestId: 'manual' }),
      /lost-response/,
    );
    responseLost = false;
    assert.equal(
      (await claimManualAssignment({ store: stores[0]!, client, source, requestId: 'manual' }))
        .status,
      'handled',
    );
    assert.equal(writes, 1);
  });

  it('should keep unclaimed local work free of election writes and installation state', async () => {
    assert.equal((await local()).status, 'local');
    assert.equal(writes, 0);
    assert.equal(await stores[0]!.inspect(), undefined);
    assert.equal(
      await recoverAssignmentClaim({
        store: stores[0]!,
        client,
        source,
        recoveryId: 'local-recovery',
        predecessorReceipt: 'local-native',
        operation: 'preview',
      }),
      undefined,
    );
    assert.equal(await stores[0]!.inspect(), undefined);
  });

  it('should hold visible swarm ownership when another installation routes locally', async () => {
    await pass(0, 'first');
    assert.deepEqual(await local(1), {
      status: 'recovery-required',
      code: 'claim-route-conflict',
      winnerId: 1,
    });
    assert.equal(await stores[1]!.inspect(), undefined);
    await assert.rejects(local(0), /claim-disabled-pending/);
    assert.equal(writes, 1);
    assert.equal((await pass(0)).status, 'owned');
  });

  it('should refuse unresolved control metadata and incomplete reads before local admission', async () => {
    await pass(0, 'first');
    comments[0]!.body = comments[0]!.body.replace('claim:v1', 'claim:v99');
    await assert.rejects(local(1), /claim-metadata-unresolved/);
    client.list = async () => {
      throw Error('claim-list-incomplete');
    };
    await assert.rejects(local(1), /claim-list-incomplete/);
    assert.equal(await stores[1]!.inspect(), undefined);
  });
  const pass = (
    index: number,
    passId = 'second',
    override: Partial<ClaimClient> = {},
    hasCapacity = true,
    eligibleInstanceIds?: string[],
    selectedSource = source,
  ) =>
    claimAssignment({
      store: stores[index]!,
      client: { ...client, ...override },
      source: selectedSource,
      passId,
      hasCapacity,
      eligibleInstanceIds,
    });
  const race = async (eligibleInstanceIds?: string[], selectedSource = source) => {
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const override = {
      async list() {
        const snapshot = structuredClone(comments);
        if (++reads === 2) release();
        await barrier;
        return snapshot;
      },
    };
    return Promise.all([
      pass(0, 'first', override, true, eligibleInstanceIds, selectedSource),
      pass(
        1,
        'first',
        override,
        true,
        eligibleInstanceIds && [...eligibleInstanceIds].reverse(),
        selectedSource,
      ),
    ]);
  };

  it('should elect one eligible claimant regardless of pool ordering', async () => {
    const pool = await Promise.all(
      stores.map(async (store) => (await store.identity()).instanceId),
    );
    assert.ok((await race(pool)).every((claim) => claim.status === 'pending'));
    const results = await Promise.all(
      stores.map((_store, index) => pass(index, 'second', {}, true, [...pool].reverse())),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), ['other-owner', 'owned']);
    assert.equal(comments.length, 1);
    assert.ok(results.every((result) => result.winnerId === comments[0]!.databaseId));
  });

  it('should reserve once and reject a stale checkpoint on independent connections to the same database', async () => {
    const location = codexStorageLocation(root);
    const first = bindSqliteInstallation(location);
    const second = bindSqliteInstallation(location);
    await first.install();
    const openStore = () => bindInstanceStore(location, 'sqlite');
    const identity = await openStore().identity();
    const [left, right] = await Promise.all([openStore().read(), openStore().read()]);
    assert.ok(left && right);
    const key = 'a'.repeat(64);
    const reserve = (pass: string) => ({
      ...left,
      claims: { [key]: { instanceId: identity.instanceId, firstPass: pass, attempted: true } },
    });
    const results = await Promise.allSettled([
      first.saveAssignmentClaims(reserve('first'), left),
      second.saveAssignmentClaims(reserve('second'), right),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected');
    assert.match(loser?.reason.message, /claim-checkpoint-conflict/u);
    const reserved = await openStore().read();
    assert.ok(reserved);
    assert.equal(
      reserved.claims[key]!.firstPass,
      results[0]!.status === 'fulfilled' ? 'first' : 'second',
    );

    const completed = structuredClone(reserved);
    completed.claims[key]!.commentId = 42;
    await first.saveAssignmentClaims(completed, reserved);
    const stale = structuredClone(reserved);
    stale.claims[key]!.commentId = 99;
    await assert.rejects(
      second.saveAssignmentClaims(stale, reserved),
      /claim-checkpoint-conflict/u,
    );
    assert.deepEqual(await openStore().read(), completed);
  });

  it('should allow sqlite identity reads but exclude rotation while publishing a claim', async () => {
    const location = codexStorageLocation(root);
    await bindSqliteInstallation(location).install();
    const first = bindInstanceStore(location, 'sqlite');
    const peer = bindInstanceStore(location, 'sqlite');
    const identity = await first.identity();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const create = client.create;
    client.create = async (...args) => {
      entered.resolve();
      await resume.promise;
      return create(...args);
    };
    const publishing = claimManualAssignment({ store: first, client, source, requestId: 'manual' });
    try {
      await entered.promise;
      assert.deepEqual(await peer.identity(), identity);
      await assert.rejects(peer.rotate(identity.instanceId), {
        code: 'private-state-file-lock-busy',
      });
    } finally {
      resume.resolve();
      await publishing;
    }
    assert.equal(writes, 1);
    assert.notEqual((await peer.rotate(identity.instanceId)).instanceId, identity.instanceId);
  });

  it('should retain one assignment winner across two sqlite installations and a restart', async () => {
    const locations = ['a', 'b'].map((name) => codexStorageLocation(join(root, name)));
    const reopen = () => locations.map((location) => bindInstanceStore(location, 'sqlite'));
    await Promise.all(locations.map((location) => bindSqliteInstallation(location).install()));
    stores = reopen();
    const pool = await Promise.all(
      stores.map(async (store) => (await store.identity()).instanceId),
    );
    assert.ok((await race(pool)).every((decision) => decision.status === 'pending'));
    stores = reopen();
    const results = await Promise.all(stores.map((_, i) => pass(i, 'second', {}, true, pool)));
    assert.deepEqual(results.map((result) => result.status).sort(), ['other-owner', 'owned']);
    const winner = results.findIndex((result) => result.status === 'owned');
    const store = stores[winner]!;
    const before = await store.read();
    const rotated = await store.rotate(pool[winner]!);
    stores = reopen();
    const after = await stores[winner]!.read();
    assert.equal(after?.instanceId, rotated.instanceId);
    assert.deepEqual(after?.claims, before?.claims);
    assert.equal((await pass(winner)).code, 'claim-instance-rotated');
    assert.equal(comments.length, 1);
  });

  it('should elect one reviewer for the same real review request through the shared claim owner', async () => {
    const request: ClaimSource = {
      ...source,
      kind: 'review-request',
      assignmentEventId: 'RE_request',
    };
    assert.ok((await race(undefined, request)).every((claim) => claim.status === 'pending'));
    const results = await Promise.all(
      stores.map((_store, index) => pass(index, 'settled', {}, true, undefined, request)),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), ['other-owner', 'owned']);
    assert.equal(comments.length, 1);
  });

  it('should restrict new claims to the eligible pool without transferring visible ownership', async () => {
    const a = (await stores[0]!.identity()).instanceId;
    const b = (await stores[1]!.identity()).instanceId;
    const select = (
      index: number,
      eligibleInstanceIds: string[],
      passId = 'first',
      hasCapacity = true,
      nativeAttempted = false,
    ) =>
      selectAssignmentClaim({
        store: stores[index]!,
        client,
        source,
        passId,
        hasCapacity,
        mode: 'swarm',
        eligibleInstanceIds,
        nativeAttempted,
      });
    const excluded = await select(1, [a]);
    assert.equal(excluded.code, 'claim-route-instance-ineligible');
    assert.equal(excluded.routing?.eligible, false);
    assert.deepEqual(excluded.routing?.eligibleInstanceIds, [a]);
    assert.equal((await select(0, [a], 'first', false)).status, 'at-capacity');
    assert.equal(writes, 0);
    assert.equal((await select(0, [a])).status, 'pending');
    assert.equal((await select(0, [a, b], 'second')).status, 'owned');
    const moved = await select(0, [b], 'third');
    assert.equal(moved.code, 'claim-route-owner-ineligible');
    assert.equal(moved.routing?.ownerInstanceId, a);
    assert.equal((await select(1, [b], 'second')).status, 'other-owner');
    assert.equal(writes, 1);
    assert.equal((await select(0, [b], 'fourth', true, true)).status, 'owned');
    await acceptAssignmentClaim({
      store: stores[0]!,
      client,
      source,
      nativeReceipt: 'original-chat',
    });
    await stores[0]!.rename('renamed-owner');
    assert.equal((await select(0, [b], 'fifth')).status, 'owned');
    assert.equal((await select(1, [b], 'third')).status, 'other-owner');
    assert.equal(writes, 1);
  });

  it('should leave an unknown or rotated target pending without falling back', async () => {
    const identity = await stores[0]!.identity();
    await stores[0]!.rotate(identity.instanceId);
    const result = await selectAssignmentClaim({
      store: stores[0]!,
      client,
      source,
      passId: 'new',
      hasCapacity: true,
      mode: 'swarm',
      eligibleInstanceIds: [identity.instanceId],
    });
    assert.equal(result.code, 'claim-route-instance-ineligible');
    assert.equal(writes, 0);
  });

  it('should transfer only the exact accepted local claim and converge after reservation', async () => {
    await pass(0, 'first');
    await pass(0, 'second');
    await acceptAssignmentClaim({ store: stores[0]!, client, source, nativeReceipt: 'old-chat' });
    const recover = (
      operation: 'preview' | 'reserve' | 'accept',
      successorReceipt?: string,
      index = 0,
    ) =>
      recoverAssignmentClaim({
        store: stores[index]!,
        client,
        source,
        predecessorReceipt: 'old-chat',
        recoveryId: 'exact-recovery',
        operation,
        successorReceipt,
      });
    const before = structuredClone(comments);
    assert.ok(await recover('preview'));
    await assert.rejects(recover('reserve', undefined, 1), /claim-recovery-owner-unresolved/);
    await recover('reserve');
    await recover('reserve');
    assert.equal((await pass(0, 'third')).code, 'claim-recovery-reserved');
    await assert.rejects(
      acceptAssignmentClaim({ store: stores[0]!, client, source, nativeReceipt: 'old-chat' }),
      /claim-recovery-reserved/,
    );
    await recover('accept', 'new-chat');
    await recover('accept', 'new-chat');
    await assert.rejects(recover('accept', 'competing-chat'), /claim-native-receipt-conflict/);
    assert.deepEqual(comments, before);
    assert.equal(writes, 1);
  });

  it('should admit only the earliest claimant on a later pass and clean only the loser', async () => {
    await race();
    assert.equal(comments.length, 2);
    assert.equal((await pass(0, 'first')).status, 'pending');
    const winnerId = parseAssignmentClaim(comments[0]!)!.instanceId;
    const winner = (await stores[0]!.identity()).instanceId === winnerId ? 0 : 1;
    assert.equal((await pass(1 - winner)).status, 'other-owner');
    assert.equal((await pass(winner)).status, 'owned');
    assert.equal(comments.length, 1);
    assert.equal(parseAssignmentClaim(comments[0]!)!.instanceId, winnerId);
    assert.equal((await pass(1 - winner, 'third')).status, 'other-owner');
    assert.equal(writes, 2);
  });

  it('should avoid publishing without capacity or when another claim is visible', async () => {
    assert.equal((await pass(0, 'first', {}, false)).status, 'at-capacity');
    assert.equal(writes, 0);
    await pass(0, 'first');
    assert.equal((await pass(1, 'first')).status, 'other-owner');
    assert.equal(writes, 1);
    comments = [];
    assert.equal((await pass(1)).code, 'claim-winner-missing');
  });

  for (const backend of ['file', 'sqlite'] as const) {
    it(
      'should recover an uncertain ' + backend + ' claim after restart without posting twice',
      async () => {
        const location = codexStorageLocation(join(root, 'a'));
        const db = bindSqliteInstallation(location);
        if (backend === 'sqlite') await db.install();
        const reopen = () => bindInstanceStore(location, backend);
        stores[0] = reopen();
        responseLost = true;
        await assert.rejects(
          pass(0, 'first', {
            async create(target, body) {
              if (backend === 'sqlite') {
                // a separate connection can take the writer lock during the provider call.
                const snapshot = await reopen().read();
                const claim = snapshot?.claims[assignmentClaimKey(source)];
                assert.ok(snapshot && claim?.attempted);
                const claims = {
                  ...snapshot.claims,
                  ['b'.repeat(64)]: { ...claim, firstPass: 'other' },
                };
                await db.saveAssignmentClaims({ ...snapshot, claims }, snapshot);
              }
              return client.create(target, body);
            },
          }),
          /lost-response/u,
        );
        stores[0] = reopen();
        assert.equal(
          (
            await pass(0, 'second', {
              async list() {
                return [];
              },
            })
          ).code,
          'claim-publication-unconfirmed',
        );
        assert.equal((await pass(0, 'third')).status, 'owned');
        assert.equal(writes, 1);
      },
    );
  }

  it('should retry failed losing cleanup without blocking the winner', async () => {
    await race();
    const winnerId = parseAssignmentClaim(comments[0]!)!.instanceId;
    const winner = (await stores[0]!.identity()).instanceId === winnerId ? 0 : 1;
    deletionFails = true;
    assert.equal((await pass(1 - winner)).code, 'claim-cleanup-pending');
    assert.equal((await pass(winner)).status, 'owned');
    deletionFails = false;
    assert.equal((await pass(1 - winner, 'third')).status, 'other-owner');
    assert.equal(comments.length, 1);
  });

  it('should retain identity and ownership when renamed and restarted', async () => {
    const original = await stores[0]!.identity();
    assert.match(original.displayName, /^[a-z]+-[a-z]+$/u);
    await pass(0, 'first');
    assert.deepEqual(await stores[0]!.rename('  Office_Laptop  '), {
      instanceId: original.instanceId,
      displayName: 'office-laptop',
    });
    stores[0] = new AssignmentClaimStore(join(root, 'a'));
    assert.equal((await pass(0)).status, 'owned');
    await acceptAssignmentClaim({
      store: stores[0]!,
      client,
      source,
      nativeReceipt: 'verified-chat-1',
    });
    assert.match(comments[0]!.body, /^Assignment accepted on `office-laptop`/u);
    assert.equal(parseAssignmentClaim(comments[0]!)!.instanceId, original.instanceId);
    assert.throws(() => stores[0]!.rename('bad<!--name'), /instance-name-invalid/u);
  });

  it('should detach copied work on explicit rotation and reject a stale rotation', async () => {
    const original = await stores[0]!.identity();
    await pass(0, 'first');
    await stores[1]!.identity();
    await writeFile(
      join(root, 'b', 'assignment-claims.json'),
      await readFile(join(root, 'a', 'assignment-claims.json')),
      { mode: 0o600 },
    );
    const rotated = await stores[1]!.rotate(original.instanceId);
    assert.notEqual(rotated.instanceId, original.instanceId);
    assert.equal(rotated.displayName, original.displayName);
    assert.equal((await pass(1)).code, 'claim-instance-rotated');
    assert.equal((await pass(0)).status, 'owned');
    await assert.rejects(stores[1]!.rotate(original.instanceId), /instance-rotation-stale/u);
    await assert.rejects(
      acceptAssignmentClaim({
        store: stores[1]!,
        client,
        source,
        nativeReceipt: 'copied-chat',
      }),
      /claim-owner-required/u,
    );
    assert.equal(writes, 1);
  });

  it('should hold missing or edited winning metadata and never silently replace a claim', async () => {
    await pass(0, 'first');
    await pass(0);
    comments[0]!.body = 'edited';
    assert.equal((await pass(0, 'third')).code, 'claim-winner-missing');
    assert.equal(writes, 1);
  });

  it('should exclude foreign authors and old assignment events from selection', async () => {
    const identity = await stores[1]!.identity();
    await client.create(
      source,
      claimBody(
        {
          instanceId: identity.instanceId,
          assignmentEventId: 'E_old',
        },
        identity.displayName,
      ),
    );
    await client.create(
      source,
      claimBody(
        {
          instanceId: identity.instanceId,
          assignmentEventId: source.assignmentEventId,
        },
        identity.displayName,
      ),
    );
    comments[1]!.author!.nodeId = 'U_foreign';
    await pass(0, 'first');
    assert.equal((await pass(0)).status, 'owned');
    assert.equal(writes, 3);
  });

  it('should retain the visibility limitation without treating a later read as a new grant', async () => {
    await pass(0, 'first');
    await pass(1, 'first', {
      async list() {
        return [];
      },
    });
    assert.equal((await pass(0)).status, 'owned');
    assert.equal(
      (
        await pass(1, 'second', {
          async list() {
            return [comments[1]!];
          },
        })
      ).status,
      'owned',
    );
    assert.equal((await pass(1, 'third')).code, 'claim-winner-changed');
  });
});
