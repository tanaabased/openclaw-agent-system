import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationReplyCandidateStore, {
  GitHubNotificationReplyCandidateStoreError,
} from '../channels/github/publication/reply-candidate-store.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

const identity = {
  agentId: 'tanaabot',
  conversationId: 'github:issue:repository:12',
  identity: { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' } as const,
  sourceId: 'revision-1',
};

function hasCode(expected: string) {
  return (error: unknown) =>
    error instanceof GitHubNotificationReplyCandidateStoreError && error.code === expected;
}

describe('channels/github/publication/reply-candidate-store', () => {
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

      await executor.attestPromptSelection(identity);
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
      await assert.rejects(
        store.stage(identity.agentId, 'unattested'),
        hasCode('reply-turn-prompt-selection-missing'),
      );
      await assert.rejects(
        store.attestPromptSelection({ ...identity, sourceId: 'stale-revision' }),
        hasCode('reply-turn-mismatch'),
      );
      await assert.rejects(
        store.attestPromptSelection({
          ...identity,
          identity: { ...identity.identity, lifecycleId: 'pull-request' },
        }),
        hasCode('reply-turn-mismatch'),
      );
      await store.attestPromptSelection(identity);
      await store.stage(identity.agentId, 'first');
      await store.stage(identity.agentId, 'second');
      await assert.rejects(
        store.stage(identity.agentId, 'third'),
        hasCode('reply-turn-candidate-limit'),
      );
      assert.deepEqual(await store.finish({ ...identity, turnId }), ['first', 'second']);

      const expiringTurn = await store.begin(identity);
      await store.attestPromptSelection(identity);
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

  it('should enforce the shared reply length boundary', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-length-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationReplyCandidateStore({ rootDir });
      const maximum = 'a'.repeat(maximumGitHubNotificationReplyLength);
      const acceptedTurn = await store.begin(identity);

      await store.attestPromptSelection(identity);
      await store.stage(identity.agentId, maximum);
      assert.deepEqual(await store.finish({ ...identity, turnId: acceptedTurn }), [maximum]);

      await store.begin(identity);
      await store.attestPromptSelection(identity);
      await assert.rejects(
        store.stage(identity.agentId, `${maximum}a`),
        hasCode('reply-turn-state-invalid'),
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should release a turn that finishes without attested prompt selection', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-unattested-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationReplyCandidateStore({ rootDir });
      const turnId = await store.begin(identity);

      await assert.rejects(
        store.finish({ ...identity, turnId }),
        hasCode('reply-turn-prompt-selection-missing'),
      );
      await store.begin(identity);
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
      const newIdentity = { ...identity, sourceId: 'revision-2' };
      const newTurn = await store.begin(newIdentity);

      await store.cancel({ ...identity, turnId: oldTurn });
      await store.attestPromptSelection(newIdentity);
      await store.stage(identity.agentId, 'new response');

      assert.deepEqual(await store.finish({ ...newIdentity, turnId: newTurn }), ['new response']);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
