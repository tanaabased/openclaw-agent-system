import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationConversationStateStore from '../channels/github/conversation/conversation-state-store.ts';
import GitHubNotificationAssignmentAcknowledgmentService from '../channels/github/conversation/assignment-acknowledgment-service.ts';
import type { GitHubNotificationConversationSnapshot } from '../channels/github/conversation/conversation-state.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

function snapshot(number = 12, repositoryId = 'R_repo'): GitHubNotificationConversationSnapshot {
  return {
    agentId: 'tanaabot',
    conversationId: `github:issue:${repositoryId}:${number}`,
    workspaceDir: '/workspace',
    conversation: {
      activeTurn: { eventId: 'assignment', sourceId: `EV_assignment_${number}` },
      baselineEstablished: true,
      itemKey: `github:${repositoryId}:${number}`,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    },
  };
}

describe('channels/github/conversation/conversation-state-store', () => {
  let temporaryDirectory: string;
  let rootDir: string;
  let statePath: string;
  let store: GitHubNotificationConversationStateStore;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-conversation-store-'));
    rootDir = join(temporaryDirectory, 'state');
    statePath = join(rootDir, 'tanaabot/channels/github-notification-conversations.json');
    store = new GitHubNotificationConversationStateStore({
      rootDir,
      currentUid: process.getuid?.(),
    });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('should expose only the requested lifecycle and retain the private schema seven file', async () => {
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    await store.write(second);

    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
    assert.deepEqual(await store.read(first.agentId, snapshot(14).conversationId), {
      agentId: first.agentId,
      conversationId: snapshot(14).conversationId,
      workspaceDir: first.workspaceDir,
    });
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(persisted.schemaVersion, 7);
    assert.deepEqual(persisted.conversations, {
      [first.conversationId]: first.conversation,
      [second.conversationId]: second.conversation,
    });
    assert.equal((await lstat(statePath)).mode & 0o077, 0);
    assert.equal((await lstat(rootDir)).mode & 0o077, 0);
  });

  it('should preserve another lifecycle when saving stale or overlapping snapshots', async () => {
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    await store.write(second);
    const independent = new GitHubNotificationConversationStateStore({ rootDir });
    const stale = await store.read(first.agentId, first.conversationId);
    assert.ok(stale?.conversation);
    second.conversation!.activeTurn = { eventId: 'comment', sourceId: 'a'.repeat(64) };
    await independent.write(second);
    delete stale.conversation.activeTurn;
    await store.write(stale);
    assert.deepEqual(await independent.read(second.agentId, second.conversationId), second);

    stale.conversation.mode = 'guided';
    second.conversation!.activeTurn = { eventId: 'assignment', sourceId: 'EV_next' };
    await Promise.all([store.write(stale), independent.write(second)]);
    assert.deepEqual(await store.read(first.agentId, first.conversationId), stale);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
  });

  it('should retain a second lifecycle created while an assignment acknowledgment is publishing', async () => {
    const first = snapshot();
    const second = snapshot(13);
    const service = new GitHubNotificationAssignmentAcknowledgmentService({
      conversationStateStore: store,
      publications: {
        async publish({ target }) {
          assert.equal(
            (await store.read(first.agentId, first.conversationId))?.conversation?.acknowledgment
              ?.status,
            'pending',
          );
          await new GitHubNotificationConversationStateStore({ rootDir }).write(second);
          return { target, status: 'published', receipt: { databaseId: 101, nodeId: 'IC_ack' } };
        },
      },
    });

    await service.publish({
      agentId: first.agentId,
      item: approvedNotificationItem(),
      modeId: 'work',
      workspaceDir: first.workspaceDir,
    });
    assert.equal(
      (await store.read(first.agentId, first.conversationId))?.conversation?.acknowledgment?.status,
      'published',
    );
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
  });

  it('should normalize routed ids only when they identify one durable key', async () => {
    const canonical = snapshot();
    await store.write(canonical);
    const before = await readFile(statePath, 'utf8');
    const lower = canonical.conversationId.toLowerCase();
    assert.deepEqual(await store.readRouted(canonical.agentId, lower), canonical);
    assert.equal((await store.read(canonical.agentId, lower))?.conversation, undefined);
    assert.equal(await store.readRouted(canonical.agentId, snapshot(99).conversationId), undefined);
    assert.equal(await readFile(statePath, 'utf8'), before);

    const other = snapshot(12, 'r_repo');
    await store.write(other);
    assert.deepEqual(
      await store.readRouted(canonical.agentId, canonical.conversationId),
      canonical,
    );
    assert.deepEqual(await store.readRouted(other.agentId, other.conversationId), other);
    assert.equal(await store.readRouted(canonical.agentId, 'github:issue:r_REPO:12'), undefined);
  });

  it('should project legacy state without rewriting it during reads', async () => {
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    await store.write(second);
    const legacy = JSON.parse(await readFile(statePath, 'utf8'));
    legacy.schemaVersion = 6;
    legacy.conversations[second.conversationId].revisions.IC_legacy = {
      bodyDigest: 'b'.repeat(64),
      commentDatabaseId: 100,
      reasonCode: 'comment-baseline',
      revisionId: 'c'.repeat(64),
      status: 'baseline',
    };
    const contents = JSON.stringify(legacy);
    await writeFile(statePath, contents);
    const projected = await store.read(second.agentId, second.conversationId);
    assert.deepEqual(projected?.conversation?.revisions.IC_legacy?.source, {
      itemType: 'issue',
      number: 13,
    });
    await store.readRouted(first.agentId, first.conversationId.toLowerCase());
    assert.equal(await readFile(statePath, 'utf8'), contents);

    await store.write(first);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), projected);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 7);
  });

  it('should preserve durable state and release the lock after invalid or cross-workspace writes', async () => {
    const first = snapshot();
    await store.write(first);
    const before = await readFile(statePath, 'utf8');
    await assert.rejects(
      store.write({ ...first, workspaceDir: '/another-workspace' }),
      /another workspace/u,
    );
    await assert.rejects(
      store.write({ ...first, conversation: undefined }),
      /checkpoint is missing/u,
    );
    await assert.rejects(store.write({ ...first, conversationId: 'invalid' }), /state is invalid/u);
    await assert.rejects(
      store.write({
        ...first,
        conversation: { ...first.conversation!, token: 'must-not-persist' },
      } as never),
      /state is invalid/u,
    );
    assert.equal(await readFile(statePath, 'utf8'), before);
    await new GitHubNotificationConversationStateStore({ rootDir }).write(snapshot(13));
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
  });

  it('should leave missing state absent during exact and routed reads', async () => {
    const first = snapshot();
    assert.equal(await store.read(first.agentId, first.conversationId), undefined);
    assert.equal(await store.readRouted(first.agentId, first.conversationId), undefined);
    await assert.rejects(lstat(rootDir), { code: 'ENOENT' });
  });
});
