import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationConversationStateStore from '../channels/github/conversation/conversation-state-store.ts';
import GitHubNotificationAssignmentAcknowledgmentService from '../channels/github/conversation/assignment-acknowledgment-service.ts';
import type { GitHubNotificationConversationSnapshot } from '../channels/github/conversation/conversation-state.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { initializeModelRouting } from '../channels/github/conversation/model-routing.ts';

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

  function recordPath(value: GitHubNotificationConversationSnapshot): string {
    const digest = createHash('sha256').update(value.conversationId).digest('hex');
    return join(rootDir, 'tanaabot/channels/github-notification-conversations', `${digest}.json`);
  }

  async function seedLegacy(version = 7): Promise<string> {
    await mkdir(join(rootDir, 'tanaabot/channels'), { mode: 0o700, recursive: true });
    const first = snapshot();
    const second = snapshot(13);
    const contents = JSON.stringify({
      agentId: first.agentId,
      conversations: {
        [first.conversationId]: first.conversation,
        [second.conversationId]: second.conversation,
      },
      schemaVersion: version,
      workspaceDir: first.workspaceDir,
    });
    await writeFile(statePath, contents, { mode: 0o600 });
    return contents;
  }

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

  it('should persist pending and selected routing across store restarts without changing ordinary records', async () => {
    const routed = snapshot();
    const profile = { model: 'openai/gpt-5.5', effort: 'high' } as const;
    routed.conversation!.modelRouting = initializeModelRouting({
      default: profile,
      low: profile,
      medium: profile,
      high: profile,
    });
    await store.write(routed);
    assert.equal(JSON.parse(await readFile(recordPath(routed), 'utf8')).schemaVersion, 2);
    routed.conversation!.modelRouting!.decision = {
      ...profile,
      complexity: 'low',
      source: 'assessed',
      reason: 'Localized repair.',
    };
    await store.write(routed);
    const restarted = new GitHubNotificationConversationStateStore({
      rootDir,
      currentUid: process.getuid?.(),
    });
    assert.deepEqual(await restarted.read(routed.agentId, routed.conversationId), routed);
    const corrupt = JSON.parse(await readFile(recordPath(routed), 'utf8'));
    corrupt.conversation.modelRouting.decision.model = 'openai/unconfigured';
    await writeFile(recordPath(routed), JSON.stringify(corrupt));
    await assert.rejects(restarted.read(routed.agentId, routed.conversationId));
  });

  it('should persist private lifecycle files behind a small routing index', async () => {
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
    assert.deepEqual(persisted, {
      agentId: first.agentId,
      conversationIds: [first.conversationId, second.conversationId],
      schemaVersion: 8,
      workspaceDir: first.workspaceDir,
    });
    assert.deepEqual(JSON.parse(await readFile(recordPath(first), 'utf8')), {
      ...first,
      schemaVersion: 1,
    });
    assert.deepEqual(JSON.parse(await readFile(recordPath(second), 'utf8')), {
      ...second,
      schemaVersion: 1,
    });
    assert.equal((await lstat(recordPath(first))).mode & 0o077, 0);
    assert.equal(
      (await lstat(join(rootDir, 'tanaabot/channels/github-notification-conversations'))).mode &
        0o077,
      0,
    );
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
    const legacy = JSON.parse(await seedLegacy(6));
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
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 8);
    assert.equal(await readFile(statePath.replace('.json', '.legacy.json'), 'utf8'), contents);
    assert.deepEqual(JSON.parse(await readFile(recordPath(second), 'utf8')), {
      ...projected,
      schemaVersion: 1,
    });
  });

  it('should preserve durable state and release the lock after invalid or cross-workspace writes', async () => {
    const first = snapshot();
    await store.write(first);
    const before = await readFile(statePath, 'utf8');
    const recordBefore = await readFile(recordPath(first), 'utf8');
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
    assert.equal(await readFile(recordPath(first), 'utf8'), recordBefore);
    await new GitHubNotificationConversationStateStore({ rootDir }).write(snapshot(13));
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
  });

  it('should save an existing lifecycle while another record and the index are locked', async () => {
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    await store.write(second);
    const indexBefore = await lstat(statePath);
    const firstBefore = await readFile(recordPath(first), 'utf8');
    const options = {
      retries: { factor: 1, maxTimeout: 1, minTimeout: 1, retries: 0 },
      staleMs: 30_000,
    };
    const indexLock = await acquirePrivateStateFileLock(statePath, options);
    const firstLock = await acquirePrivateStateFileLock(recordPath(first), options);
    try {
      second.conversation!.mode = 'guided';
      await new GitHubNotificationConversationStateStore({ rootDir }).write(second);
      assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
      assert.equal(await readFile(recordPath(first), 'utf8'), firstBefore);
      assert.equal((await lstat(statePath)).ino, indexBefore.ino);
    } finally {
      await firstLock.release();
      await indexLock.release();
    }
  });

  it('should retry an interrupted migration from the untouched legacy file', async () => {
    const original = await seedLegacy();
    const first = snapshot();
    const second = snapshot(13);
    const changed = snapshot();
    changed.conversation!.mode = 'guided';
    const originalWrite = PrivateStateFile.prototype.write;
    PrivateStateFile.prototype.write = async function (contents) {
      if (JSON.parse(contents).schemaVersion === 8) throw new Error('interrupted index cutover');
      return originalWrite.call(this, contents);
    };
    try {
      await assert.rejects(store.write(changed), /interrupted index cutover/u);
    } finally {
      PrivateStateFile.prototype.write = originalWrite;
    }
    assert.equal(await readFile(statePath, 'utf8'), original);
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
    assert.equal(
      JSON.parse(await readFile(recordPath(changed), 'utf8')).conversation.mode,
      'guided',
    );

    const restarted = new GitHubNotificationConversationStateStore({ rootDir });
    await restarted.write(second);
    assert.deepEqual(await restarted.read(first.agentId, first.conversationId), first);
    assert.deepEqual(await restarted.read(second.agentId, second.conversationId), second);
    assert.equal(await readFile(statePath.replace('.json', '.legacy.json'), 'utf8'), original);
    first.conversation!.mode = 'guided';
    await restarted.write(first);
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
  });

  it('should retain both writers when migration overlaps admission of another lifecycle', async () => {
    await seedLegacy();
    const first = snapshot();
    const third = snapshot(14);
    first.conversation!.mode = 'guided';
    const independent = new GitHubNotificationConversationStateStore({ rootDir });
    await Promise.all([store.write(first), independent.write(third)]);
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
    assert.deepEqual(await store.read(third.agentId, third.conversationId), third);
    assert.deepEqual(await store.read(first.agentId, snapshot(13).conversationId), snapshot(13));
  });

  it('should ignore an unindexed record after a failed admission and recover on retry', async () => {
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    const originalWrite = PrivateStateFile.prototype.write;
    PrivateStateFile.prototype.write = async function (contents) {
      if (JSON.parse(contents).schemaVersion === 8) throw new Error('interrupted admission');
      return originalWrite.call(this, contents);
    };
    try {
      await assert.rejects(store.write(second), /interrupted admission/u);
    } finally {
      PrivateStateFile.prototype.write = originalWrite;
    }
    assert.equal(
      (await store.read(second.agentId, second.conversationId))?.conversation,
      undefined,
    );
    assert.equal(await store.readRouted(second.agentId, second.conversationId), undefined);
    await new GitHubNotificationConversationStateStore({ rootDir }).write(second);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
  });

  it('should isolate damaged records and never resurrect a missing record from the legacy backup', async () => {
    await seedLegacy();
    const first = snapshot();
    const second = snapshot(13);
    await store.write(first);
    await writeFile(recordPath(first), '{invalid');
    await assert.rejects(store.read(first.agentId, first.conversationId), /state is invalid/u);
    await assert.rejects(store.write(first), /state is invalid/u);
    second.conversation!.mode = 'guided';
    await store.write(second);
    assert.deepEqual(
      await store.readRouted(second.agentId, second.conversationId.toLowerCase()),
      second,
    );
    await rm(recordPath(first));
    await assert.rejects(store.read(first.agentId, first.conversationId), /record is missing/u);
    await assert.rejects(store.write(first), /record is missing/u);
    assert.deepEqual(await store.read(second.agentId, second.conversationId), second);
  });

  it('should reject records with mismatched identity, workspace, schema, or excessive size', async () => {
    const first = snapshot();
    await store.write(first);
    for (const override of [
      { agentId: 'other' },
      { conversationId: snapshot(13).conversationId },
      { workspaceDir: '/other' },
      { schemaVersion: 2 },
      { unexpected: 'data' },
    ]) {
      await writeFile(
        recordPath(first),
        JSON.stringify({ ...first, schemaVersion: 1, ...override }),
      );
      await assert.rejects(store.read(first.agentId, first.conversationId), /state is invalid/u);
    }
    await writeFile(recordPath(first), 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(store.read(first.agentId, first.conversationId), /size limit/u);
  });

  it('should reject unsafe record files and directories without touching their targets', async () => {
    const first = snapshot();
    await store.write(first);
    const contents = await readFile(recordPath(first), 'utf8');
    const target = join(temporaryDirectory, 'outside.json');
    await writeFile(target, contents, { mode: 0o600 });
    await rm(recordPath(first));
    await symlink(target, recordPath(first));
    await assert.rejects(store.read(first.agentId, first.conversationId), /symbolic link/u);
    await assert.rejects(store.write(first), /symbolic link/u);
    assert.equal(await readFile(target, 'utf8'), contents);
    await rm(recordPath(first));
    await writeFile(recordPath(first), contents, { mode: 0o644 });
    await chmod(recordPath(first), 0o644);
    await assert.rejects(store.read(first.agentId, first.conversationId), /private/u);
    await chmod(recordPath(first), 0o600);
    const wrongOwner = new GitHubNotificationConversationStateStore({
      rootDir,
      currentUid: (process.getuid?.() ?? 0) + 1,
    });
    await assert.rejects(wrongOwner.read(first.agentId, first.conversationId), /owned by/u);
    const directory = join(rootDir, 'tanaabot/channels/github-notification-conversations');
    await rm(directory, { recursive: true });
    await symlink(temporaryDirectory, directory);
    await assert.rejects(store.read(first.agentId, first.conversationId), /real directories/u);
    await assert.rejects(store.write(first), /real directories/u);
  });

  it('should keep provider ids out of filenames and reject malformed indexes', async () => {
    const first = snapshot(12, '../R_repo');
    await store.write(first);
    assert.deepEqual(
      await readdir(join(rootDir, 'tanaabot/channels/github-notification-conversations')),
      [recordPath(first).split('/').at(-1)],
    );
    assert.deepEqual(await store.read(first.agentId, first.conversationId), first);
    const index = JSON.parse(await readFile(statePath, 'utf8'));
    for (const override of [
      { conversationIds: [first.conversationId, first.conversationId] },
      { conversationIds: ['invalid'] },
      {
        conversationIds: Array.from(
          { length: 501 },
          (_, number) => snapshot(number + 1).conversationId,
        ),
      },
      { agentId: 'other' },
      { workspaceDir: 'relative' },
      { schemaVersion: 9 },
      { unexpected: 'data' },
    ]) {
      await writeFile(statePath, JSON.stringify({ ...index, ...override }));
      await assert.rejects(store.read(first.agentId, first.conversationId), /state is invalid/u);
      await assert.rejects(store.write(first), /state is invalid/u);
    }
  });

  it('should leave missing state absent during exact and routed reads', async () => {
    const first = snapshot();
    assert.equal(await store.read(first.agentId, first.conversationId), undefined);
    assert.equal(await store.readRouted(first.agentId, first.conversationId), undefined);
    await assert.rejects(lstat(rootDir), { code: 'ENOENT' });
  });
});
