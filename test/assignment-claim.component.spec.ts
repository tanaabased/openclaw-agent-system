import recoverAssignmentClaim from '../agent/assignment-claim-recovery.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptAssignmentClaim,
  claimAssignment,
  type ClaimClient,
  type ClaimSource,
} from '../agent/assignment-claim.ts';
import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
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
  const pass = (
    index: number,
    passId = 'second',
    override: Partial<ClaimClient> = {},
    hasCapacity = true,
  ) =>
    claimAssignment({
      store: stores[index]!,
      client: { ...client, ...override },
      source,
      passId,
      hasCapacity,
    });
  const race = async () => {
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
    return Promise.all([pass(0, 'first', override), pass(1, 'first', override)]);
  };

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

  it('should preserve uncertain publication across restart without posting again', async () => {
    responseLost = true;
    await assert.rejects(pass(0, 'first'), /lost-response/u);
    stores[0] = new AssignmentClaimStore(join(root, 'a'));
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
  });

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
