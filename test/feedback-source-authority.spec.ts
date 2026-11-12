import assert from 'node:assert/strict';
import authorizeCodexFeedback from '../agent/tasks/feedback/codex-feedback-authority.ts';
import authorizeFeedback from '../agent/tasks/feedback/feedback-source-context.ts';
import { feedbackRevision } from '../agent/tasks/feedback/feedback-source.ts';
import type { DispatchRecord } from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import type { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import type { ManagedIssue } from '../agent/tasks/managed-issue.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';

function fixture() {
  const f = intakeFixture();
  f.policy.runtimes = ['openclaw'];
  f.policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
  const source = {
    nodeId: 'C',
    databaseId: 42,
    body: '@receiver continue',
    bodyTruncated: false,
    author: account,
    createdAt: '2026-10-13T01:00:00Z',
    updatedAt: '2026-10-13T01:00:00Z',
  };
  const event = {
    number: f.item.number,
    nodeId: f.item.nodeId,
    itemType: f.item.itemType,
    source: JSON.stringify(source),
    revision: feedbackRevision(source),
  };
  const intake = {
    id: 'intake',
    receiving: account,
    repository: f.repository,
    issue: f.item,
    assignment: f.events[0],
  } as unknown as ManagedIssue;
  const current = {
    manifest: { github: { username: account.login, notifications: f.policy } },
  } as Awaited<ReturnType<typeof selectCodexTaskContext>>;
  const record = {} as DispatchRecord;
  const provider = {
    ...f.client,
    getIssueComment: async () => source,
    listIssueComments: async () => ({ comments: [source], truncated: false }),
  };
  return { ...f, source, event, intake, current, record, provider };
}

for (const runtime of ['codex', 'openclaw'] as const) {
  describe(`agent/feedback-source-authority ${runtime}`, () => {
    const authorize = (f: ReturnType<typeof fixture>) =>
      runtime === 'codex'
        ? authorizeCodexFeedback({
            ...f,
            conversation: true,
            provider: { client: f.client, comments: f.provider },
          })
        : authorizeFeedback({ ...f, conversation: true, assertCurrent: async () => {} });
    it('should continue an admitted source independently of runtime admission and issue closure', async () => {
      const f = fixture();
      f.item.state = 'closed';
      await authorize(f);
    });
    it('should reject a changed source revision', async () => {
      const f = fixture();
      f.source.body = '@receiver changed direction';
      await assert.rejects(authorize(f), /feedback-source-changed/);
    });
    it('should reject a replaced author and source identity', async () => {
      const f = fixture();
      f.source.author = { ...account, nodeId: 'other' };
      await assert.rejects(authorize(f), /feedback-source-author-changed/);
      f.source.author = account;
      f.source.nodeId = 'other';
      await assert.rejects(authorize(f), /feedback-source-identity-changed/);
    });
    it('should retain current feedback author policy', async () => {
      const f = fixture();
      f.policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
      await assert.rejects(
        authorize(f),
        (error: unknown) => (error as { reason?: string }).reason === 'feedback-not-approved',
      );
    });
    it('should reject a different issue destination', async () => {
      const f = fixture();
      f.event.nodeId = 'other';
      await assert.rejects(authorize(f), /feedback-source-owner-changed/);
    });
  });
}

describe('agent/codex-feedback-authority admission', () => {
  it('should still reject new feedback admission on a disabled runtime', async () => {
    const f = fixture();
    await assert.rejects(
      authorizeCodexFeedback({ ...f, provider: { client: f.client, comments: f.provider } }),
      (error: unknown) => (error as { reason?: string }).reason === 'feedback-disabled',
    );
  });
});
