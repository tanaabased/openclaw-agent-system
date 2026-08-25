import assert from 'node:assert/strict';

import GitHubNotificationSessionArchiveService, {
  type GitHubNotificationSessionEntry,
} from '../channels/github/conversation/session-archive-service.ts';

describe('channels/github/conversation/session-archive-service', () => {
  it('should archive metadata without refreshing activity', async () => {
    let entry: GitHubNotificationSessionEntry | undefined = {};
    const service = new GitHubNotificationSessionArchiveService({
      clock: () => 42,
      runtime: {
        getSessionEntry: () => entry,
        async patchSessionEntry(input) {
          assert.equal(input.preserveActivity, true);
          if (!entry) return;
          entry = { ...entry, ...input.update(entry) };
        },
      },
    });

    assert.equal(await service.archive('emori', 'session'), 'archived');
    assert.equal(entry?.archivedAt, 42);
    assert.equal(await service.archive('emori', 'session'), 'archived');
  });

  it('should atomically preserve a pin added after inspection', async () => {
    let entry: GitHubNotificationSessionEntry = {};
    const service = new GitHubNotificationSessionArchiveService({
      runtime: {
        getSessionEntry: () => entry,
        async patchSessionEntry(input) {
          entry.pinnedAt = 7;
          entry = { ...entry, ...input.update(entry) };
        },
      },
    });

    assert.equal(await service.archive('emori', 'session'), 'pinned');
    assert.equal(entry.archivedAt, undefined);
    assert.equal(entry.pinnedAt, 7);
  });

  it('should treat an absent session as idempotent completion', async () => {
    const service = new GitHubNotificationSessionArchiveService({
      runtime: {
        getSessionEntry: () => undefined,
        async patchSessionEntry() {
          throw new Error('not reached');
        },
      },
    });

    assert.equal(await service.archive('emori', 'session'), 'missing');
  });
});
