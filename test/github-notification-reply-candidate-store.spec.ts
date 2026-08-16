import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationReplyCandidateStore, {
  GitHubNotificationReplyCandidateStoreError,
} from '../channels/github/lib/reply-candidate-store.ts';

const identity = {
  agentId: 'tanaabot',
  conversationId: 'github:issue:repository:12',
  revisionId: 'revision-1',
};

function hasCode(expected: string) {
  return (error: unknown) =>
    error instanceof GitHubNotificationReplyCandidateStoreError && error.code === expected;
}

describe('channels/github/lib/reply-candidate-store', () => {
  it('should exchange private candidates across independent runtime instances', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-candidate-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const parent = new GitHubNotificationReplyCandidateStore({
        currentUid: process.getuid?.(),
        randomId: () => 'turn-1',
        rootDir,
      });
      const executor = new GitHubNotificationReplyCandidateStore({ rootDir });
      const turnId = await parent.begin(identity);

      await executor.stage(identity.agentId, ' ready ');

      assert.equal(turnId, 'turn-1');
      assert.deepEqual(await parent.finish({ ...identity, turnId }), ['ready']);
      assert.equal((await lstat(rootDir)).mode & 0o077, 0);
      assert.equal((await lstat(join(rootDir, 'tanaabot/channels'))).mode & 0o077, 0);
      await assert.rejects(
        lstat(join(rootDir, 'tanaabot/channels/github-notification-reply-turn.json')),
        /ENOENT/u,
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should reject overlapping, mismatched, expired, and excess candidate operations', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-turn-'));
    const rootDir = join(temporaryDirectory, 'state');
    let now = Date.parse('2026-08-15T12:00:00.000Z');
    let sequence = 0;
    try {
      const store = new GitHubNotificationReplyCandidateStore({
        now: () => now,
        randomId: () => `turn-${++sequence}`,
        rootDir,
        ttlMs: 1_000,
      });
      const turnId = await store.begin(identity);

      await assert.rejects(store.begin(identity), hasCode('reply-turn-already-active'));
      await assert.rejects(
        store.finish({ ...identity, turnId: 'stale-turn' }),
        hasCode('reply-turn-mismatch'),
      );
      await store.stage(identity.agentId, 'first');
      await store.stage(identity.agentId, 'second');
      await assert.rejects(
        store.stage(identity.agentId, 'third'),
        hasCode('reply-turn-candidate-limit'),
      );
      assert.deepEqual(await store.finish({ ...identity, turnId }), ['first', 'second']);

      const expiringTurn = await store.begin(identity);
      now += 1_001;
      await assert.rejects(
        store.finish({ ...identity, turnId: expiringTurn }),
        hasCode('reply-turn-expired'),
      );
      await assert.rejects(store.stage(identity.agentId, 'late'), hasCode('reply-turn-missing'));
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should leave a newer turn intact when an older parent cancels', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-cancel-'));
    const rootDir = join(temporaryDirectory, 'state');
    let now = Date.parse('2026-08-15T12:00:00.000Z');
    let sequence = 0;
    try {
      const store = new GitHubNotificationReplyCandidateStore({
        now: () => now,
        randomId: () => `turn-${++sequence}`,
        rootDir,
        ttlMs: 1_000,
      });
      const oldTurn = await store.begin(identity);
      now += 1_001;
      const newTurn = await store.begin({ ...identity, revisionId: 'revision-2' });

      await store.cancel({ ...identity, turnId: oldTurn });
      await store.stage(identity.agentId, 'new response');

      assert.deepEqual(
        await store.finish({ ...identity, revisionId: 'revision-2', turnId: newTurn }),
        ['new response'],
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
