import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexDeliveryState } from '../agent/codex-delivery-state.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { DirectEntryStore } from '../agent/direct-entry-store.ts';
import type DispatchStore from '../agent/dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { implementationEntriesSchema } from '../agent/implementation-entry-state.ts';
import type { ManagedIssue } from '../agent/managed-issue.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import pendingRetirement from '../agent/pending-retirement.ts';
import reconcileRetirementEffects from '../agent/reconcile-retirement-effects.ts';
import ReplyStore, { type ReplyDraft } from '../agent/reply-store.ts';
import { retirementDeliveryEffects, type RetirementEffect } from '../agent/retirement-effects.ts';
import retirementLocalData from '../agent/retirement-local-data.ts';
import { githubNotificationPublicationComment } from '../channels/github/publication/publication-contract.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';

const task = (id: string): SharedDispatchRecord => ({
  id: id.repeat(64),
  intakeId: id.repeat(64),
  issueKey: id.repeat(64),
  sourceThreadId: 'intake',
  phase: 'routing',
  createdAt: 1,
  manifestDigest: 'manifest',
  context: 'copied plan',
  retirement: {
    reason: 'operator-requested',
    at: 1,
    checkedAt: 1,
    eligibleAt: 1,
    intakeId: id.repeat(64),
  },
});
const publication = JSON.stringify({
  intent: 'status-update',
  publicationId: 'publication',
  text: 'already attempted',
  item: {
    lifecycleId: 'issue',
    number: 3,
    repositoryOwner: 'owner',
    repositoryName: 'repo',
    repositoryNodeId: 'R_repo',
  },
});
const pending: RetirementEffect = {
  id: 'e'.repeat(64),
  kind: 'comment',
  accountId: account.nodeId,
  publication,
};

describe('agent/retirement disposal', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'retirement-disposal-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const Store of [CodexDispatchStore, OpenClawDispatchStore]) {
    it(`should preserve replacement fences after disposing either attempt in ${Store.name.toLowerCase()}`, async () => {
      for (const remove of [0, 1]) {
        const store: DispatchStore<SharedDispatchRecord> = new Store(
          root,
          String(remove + 1).repeat(64),
        );
        const predecessor = task('a'),
          successor = task('c');
        predecessor.supersededBy = successor.id;
        successor.predecessorId = predecessor.id;
        successor.issueKey = predecessor.issueKey;
        await store.exclusive(async (state, save) => {
          state.records.push(predecessor, successor);
          await save();
        });
        await store.exclusive(async (state, save) => {
          await store.dispose(state, state.records[remove]!);
          await save();
        });
        assert.deepEqual((await store.read()).records, [remove === 0 ? successor : predecessor]);
      }
    });

    it(`should remove exact task records while preserving a sibling in ${Store.name.toLowerCase()}`, async () => {
      const store: DispatchStore<SharedDispatchRecord> = new Store(root, 'b'.repeat(64));
      const original = task('a'),
        sibling = task('c');
      await store.exclusive(async (state, save) => {
        state.records.push(original, sibling);
        await save();
      });
      await store.exclusive(async (state, save) => {
        store.retainRetirementEffects(state, [pending]);
        pendingRetirement(state.records[0]!);
        await save();
      });
      const restarted: DispatchStore<SharedDispatchRecord> = new Store(root, store.scope);
      const before = await restarted.read();
      assert.equal(before.records[0]!.context, undefined);
      assert.equal(before.records[0]!.cleanupPending, true);
      assert.deepEqual(before.records[1], sibling);
      await restarted.exclusive(async (state, save) => {
        await restarted.dispose(state, state.records[0]!);
        await save();
      });
      const after = await restarted.read();
      assert.deepEqual(after.records, [sibling]);
      assert.deepEqual(after.retirementEffects, [pending]);
      await assert.rejects(
        restarted.exclusive((state) => restarted.dispose(state, original)),
        /retirement-task-missing/,
      );
      assert.deepEqual((await restarted.read()).records, [sibling]);
    });

    it(`should reject an in-flight task write after disposal in ${Store.name.toLowerCase()}`, async () => {
      const store: DispatchStore<SharedDispatchRecord> = new Store(root, 'b'.repeat(64));
      await store.exclusive(async (state, save) => {
        state.records.push(task('a'));
        await save();
      });
      await assert.rejects(
        store.transaction(async (state, save) => {
          state.records[0]!.context = 'late task result';
          await store.exclusive(async (current, commit) => {
            await store.dispose(current, current.records[0]!);
            await commit();
          });
          await save();
        }),
        /state-snapshot-conflict/,
      );
      assert.deepEqual((await store.read()).records, []);
    });
  }

  it('should remove exact direct work copies while preserving another target in the same chat', async () => {
    const binding = {
      runtime: 'codex' as const,
      agentId: 'receiver',
      workspace: root,
      namespace: root,
      session: 'task',
      incarnation: 'task',
    };
    const fixture = intakeFixture();
    const intake = {
      receiving: account,
      repository: fixture.repository,
      issue: fixture.item,
    } as unknown as ManagedIssue;
    const store = new DirectEntryStore(
      root,
      binding,
      implementationEntriesSchema,
      'implementation',
    );
    const source = { turnId: 'turn', inputId: 'input' };
    const entry = {
      id: 'a'.repeat(64),
      target: 'https://github.com/owner/repo/issues/3',
      repositoryId: fixture.repository.nodeId,
      subjectId: fixture.item.nodeId,
      checkout: { path: root, revision: 'a'.repeat(40), dirty: false },
      scope: 'local' as const,
      authorization: source,
      scopeSource: source,
      caller: source,
    };
    const unrelated = { ...entry, id: 'b'.repeat(64), subjectId: 'I_other' };
    await store.exclusive(async (entries, save) => {
      entries.push(entry, unrelated);
      await save();
    });
    await retirementLocalData({ root, binding, intake, retain: async () => {} });
    await store.exclusive(async (entries) => {
      assert.deepEqual(entries, [unrelated]);
    });
  });

  it('should retain attempted delivery uncertainty but discard confirmed pushes and unsent content', () => {
    const fixture = intakeFixture();
    const intake = {
      receiving: account,
      repository: fixture.repository,
      issue: fixture.item,
    } as unknown as ManagedIssue;
    const head = 'a'.repeat(40);
    const delivery: CodexDeliveryState = {
      id: 'a'.repeat(64),
      binding: {
        repositoryId: fixture.repository.nodeId,
        issueId: fixture.item.nodeId,
        threadId: 'task',
        worktree: root,
        branch: 'task',
        base: 'main',
        head,
        authorId: account.nodeId,
        policyDigest: 'b'.repeat(64),
      },
      creationAttempted: false,
      reconciled: false,
      attached: false,
      cardAttempts: 0,
      pendingPush: { previousHead: '', head },
      pushedHead: head,
      contentUpdate: { title: 'prepared only' },
      contentUpdateAttempted: false,
    };
    assert.deepEqual(retirementDeliveryEffects(delivery, intake), []);
    delivery.contentUpdateAttempted = true;
    assert.equal(retirementDeliveryEffects(delivery, intake).length, 1);
    delivery.contentUpdateAttempted = false;
    delete delivery.pushedHead;
    assert.equal(retirementDeliveryEffects(delivery, intake).length, 1);
  });

  it('should transfer only uncertain reply attempts before deleting local drafts', async () => {
    const binding = {
      runtime: 'codex' as const,
      agentId: 'receiver',
      workspace: root,
      namespace: root,
      session: 'task',
      incarnation: 'task',
    };
    const store = new ReplyStore(root, binding);
    const draft: ReplyDraft = {
      id: 'a'.repeat(64),
      turnId: 'turn',
      inputId: 'input',
      target: '{}',
      privateText: 'private plan copy',
      configuration: 'b'.repeat(64),
      ownerContext: 'task context',
      authorLogin: account.login,
      authorNodeId: account.nodeId,
      selection: {
        version: 1,
        requestedSkill: 'reply',
        defaultSkill: true,
        skill: { name: 'reply', path: '/reply', scope: 'fixture', digest: 'b'.repeat(64) },
        observedAt: 1,
      },
      publicText: 'already attempted',
      publication,
      attempted: true,
    };
    await store.exclusive(async (drafts, save) => {
      drafts.push(
        draft,
        { ...draft, id: 'b'.repeat(64), attempted: false },
        { ...draft, id: 'c'.repeat(64), receipt: { nodeId: 'IC_done', databaseId: 1 } },
      );
      await save();
    });
    const fixture = intakeFixture();
    const intake = {
      receiving: account,
      repository: fixture.repository,
      issue: fixture.item,
    } as unknown as ManagedIssue;
    const effects: RetirementEffect[] = [];
    await assert.rejects(
      retirementLocalData({
        root,
        binding,
        intake,
        retain: async () => {
          throw new Error('storage-unavailable');
        },
      }),
      /storage-unavailable/,
    );
    assert.equal((await store.read()).length, 3);
    await retirementLocalData({
      root,
      binding,
      intake,
      retain: async (entries) => {
        effects.push(...entries);
      },
    });
    assert.deepEqual(await store.read(), []);
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.publication, publication);
    assert.ok(!JSON.stringify(effects).includes('private plan copy'));
    assert.ok(!JSON.stringify(effects).includes('task context'));
  });

  it('should reconcile remaining effects through reads without reposting or restoring a task', async () => {
    const fixture = intakeFixture();
    const effects = [structuredClone(pending)];
    let visible = false,
      reads = 0;
    const comments = async () => ({
      identity: account,
      getRepository: fixture.client.getRepository,
      findOwnIssueComment: async (
        _owner: string,
        _name: string,
        _number: number,
        marker: string,
      ) => {
        reads++;
        return visible
          ? {
              nodeId: 'IC_reply',
              databaseId: 8,
              body: githubNotificationPublicationComment('already attempted', marker),
            }
          : undefined;
      },
      replies: {
        find: async () => undefined,
        create: async () => {
          throw new Error('no writes');
        },
      },
    });
    const reconcile = () =>
      reconcileRetirementEffects({
        effects,
        comments,
        delivery: async () => {
          throw new Error('no delivery');
        },
        save: async () => {},
      });
    await reconcile();
    assert.equal(effects[0]!.code, 'retirement-effect-unconfirmed');
    visible = true;
    await reconcile();
    assert.deepEqual(effects, []);
    assert.equal(reads, 2);
  });
});
