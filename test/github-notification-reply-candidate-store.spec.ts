import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
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

function turnPath(rootDir: string, conversationId = identity.conversationId) {
  return join(
    rootDir,
    identity.agentId,
    'channels/github-notification-reply-turns',
    `${createHash('sha256').update(conversationId).digest('hex')}.json`,
  );
}

describe('channels/github/publication/reply-candidate-store', () => {
  it('should isolate prompt selection, expiry, stale attempts, cancellation, and completion by conversation', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-isolation-'));
    const rootDir = join(temporaryDirectory, 'state');
    let now = 1_000;
    let sequence = 0;
    const store = new GitHubNotificationReplyCandidateStore({
      rootDir,
      now: () => now,
      ttlMs: 1_000,
      randomId: () => `attempt-${++sequence}`,
    });
    const other = { ...identity, conversationId: 'github:issue:repository:13' };
    try {
      const first = { ...identity, turnId: await store.begin(identity) };
      await store.attestPromptSelection(identity);
      now += 500;
      const second = { ...other, turnId: await store.begin(other) };
      await assert.rejects(
        store.stage(second, 'unattested'),
        hasCode('reply-turn-prompt-selection-missing'),
      );
      await store.attestPromptSelection(other);
      await store.stage(second, 'second conversation');
      await assert.rejects(
        store.begin({ ...identity, sourceId: 'competing-source' }),
        hasCode('reply-turn-already-active'),
      );
      await store.cancel({ ...second, turnId: first.turnId });
      now += 501;
      await assert.rejects(store.stage(first, 'expired'), hasCode('reply-turn-expired'));
      const replacement = { ...identity, turnId: await store.begin(identity) };
      await store.attestPromptSelection(identity);
      await assert.rejects(store.stage(first, 'stale attempt'), hasCode('reply-turn-mismatch'));
      await store.cancel(first);
      await store.stage(replacement, 'replacement');
      assert.deepEqual(await store.finish(second), ['second conversation']);
      assert.deepEqual(await store.finish(replacement), ['replacement']);
      await assert.rejects(store.finish(second), hasCode('reply-turn-missing'));
      assert.equal(
        (await lstat(join(rootDir, identity.agentId, 'channels/github-notification-reply-turns')))
          .mode & 0o077,
        0,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('should migrate an active legacy turn without blocking unrelated conversations or losing candidates', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-legacy-'));
    const rootDir = join(temporaryDirectory, 'state');
    const store = new GitHubNotificationReplyCandidateStore({ rootDir });
    const executor = new GitHubNotificationReplyCandidateStore({ rootDir });
    const legacyPath = join(
      rootDir,
      identity.agentId,
      'channels/github-notification-reply-turn.json',
    );
    try {
      const first = { ...identity, turnId: await store.begin(identity) };
      await store.attestPromptSelection(identity);
      await store.stage(first, 'legacy candidate');
      await copyFile(turnPath(rootDir), legacyPath);
      await rm(turnPath(rootDir));
      const other = { ...identity, conversationId: 'github:issue:repository:13' };
      const second = { ...other, turnId: await executor.begin(other) };
      await executor.attestPromptSelection(other);
      await executor.stage(second, 'independent candidate');
      assert.deepEqual(await executor.finish(first), ['legacy candidate']);
      assert.deepEqual(await store.finish(second), ['independent candidate']);
      await assert.rejects(lstat(legacyPath), { code: 'ENOENT' });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
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

      await assert.rejects(
        parent.assertPromptSelected(identity),
        hasCode('reply-turn-prompt-selection-missing'),
      );
      await executor.attestPromptSelection(identity);
      await parent.assertPromptSelected(identity);
      await assert.rejects(
        parent.assertPromptSelected({ ...identity, sourceId: 'another-turn' }),
        hasCode('reply-turn-mismatch'),
      );
      await executor.stage({ ...identity, turnId }, ' ready ');

      assert.equal(turnId, 'turn-1');
      assert.deepEqual(await parent.finish({ ...identity, turnId }), ['ready']);
      assert.equal((await lstat(rootDir)).mode & 0o077, 0);
      assert.equal((await lstat(join(rootDir, 'tanaabot/channels'))).mode & 0o077, 0);
      await assert.rejects(lstat(turnPath(rootDir)), /ENOENT/u);
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
        store.stage({ ...identity, turnId }, 'unattested'),
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
      await store.stage({ ...identity, turnId }, 'first');
      await store.stage({ ...identity, turnId }, 'second');
      await assert.rejects(
        store.stage({ ...identity, turnId }, 'third'),
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
      await assert.rejects(
        store.stage({ ...identity, turnId }, 'late'),
        hasCode('reply-turn-missing'),
      );
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
      await store.stage({ ...identity, turnId: acceptedTurn }, maximum);
      assert.deepEqual(await store.finish({ ...identity, turnId: acceptedTurn }), [maximum]);

      const rejectedTurn = await store.begin(identity);
      await store.attestPromptSelection(identity);
      await assert.rejects(
        store.stage({ ...identity, turnId: rejectedTurn }, `${maximum}a`),
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
      await store.stage({ ...newIdentity, turnId: newTurn }, 'new response');

      assert.deepEqual(await store.finish({ ...newIdentity, turnId: newTurn }), ['new response']);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
