import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { renderBoundAssessment } from '../agent/tasks/assessment/assessment-render.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import assignmentCard from '../channels/github/presentation/assignment-card.ts';
import {
  githubCommentCard,
  githubNotificationCommentPresentation,
} from '../channels/github/presentation/comment.ts';
import { githubNotificationPullRequestOpenedCard } from '../channels/github/presentation/pull-request-opened.ts';
import safePresentation from '../channels/github/presentation/safe.ts';

const target = 'https://github.com/owner/repo/issues/3';
describe('presentation failure isolation', () => {
  it('should fall back only from formatting without running an effect twice', () => {
    let rendered = 0;
    assert.equal(
      safePresentation(
        () => {
          rendered++;
          throw new Error('format failure');
        },
        () => target,
      ),
      target,
    );
    assert.equal(rendered, 1);
  });
  it('should retain assignment destination and sender when card formatting rejects metadata', () => {
    const card = assignmentCard({
      emoji: '\n',
      item: { kind: 'Issue', label: 'owner/repo#3', url: target },
      sender: { label: 'sender', url: 'https://github.com/sender' },
    });
    assert.ok(card.includes(target));
    assert.match(card, /sender/);
  });
  it('should preserve incoming and published text and urls if text decoration throws', () => {
    const original = String.prototype.replace;
    const stub = mock.method(
      String.prototype,
      'replace',
      function (this: string, ...args: Parameters<typeof original>) {
        if (String(this) === 'Exact authored body.') throw new Error('renderer failed');
        return original.apply(this, args);
      },
    );
    try {
      const source = {
        body: 'Exact authored body.',
        author: { label: 'sender', url: 'https://github.com/sender' },
        item: { label: 'owner/repo#3', url: target + '#issuecomment-5' },
      };
      const incoming = githubNotificationCommentPresentation(source);
      const published = githubCommentCard({
        ...source,
        label: 'Reply',
        connector: 'by',
        publication: { url: source.item.url },
      });
      for (const text of [incoming, published]) {
        assert.ok(text.includes(source.body));
        assert.ok(text.includes(source.item.url));
        assert.ok(text.includes(source.author.label));
      }
    } finally {
      stub.mock.restore();
    }
  });
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should keep a useful ${runtime} assessment despite broken optional routing and preserve ownership rejection`, async () => {
      const record = {
        id: 'd'.repeat(64),
        threadId: 'thread',
        request: { key: 'issue' },
        routing: '{not-json',
        manualIssue: {
          repository: { owner: { login: 'owner' }, name: 'repo' },
          issue: { number: 3 },
        },
      } as SharedDispatchRecord;
      const context = {
        runtime,
        records: [record],
        admitted: [],
        session: 'thread',
        workspace: '/workspace',
      };
      const input = {
        action: 'assessment',
        operation: 'render',
        target,
        result: {
          outcome: 'clarification-needed',
          summary: 'Choose retention.',
          questions: ['How long?'],
        },
      };
      const result = await renderBoundAssessment(input, context);
      assert.equal(result.status, 'formatted');
      assert.match(String(result.presentation), /How long/);
      record.routing = JSON.stringify({ selection: { model: '', effort: '' } });
      const fallback = await renderBoundAssessment(input, context);
      assert.equal(fallback.status, 'formatted');
      assert.match(String(fallback.presentation), /How long/);
      assert.ok(String(fallback.presentation).includes(target));
      await assert.rejects(
        renderBoundAssessment({ ...input, target: target.replace('/3', '/4') }, context),
        /assessment-managed-target-mismatch/,
      );
    });
  it('should retain a confirmed pr link if card generation fails', () => {
    const stub = mock.method(String.prototype, 'replace', () => {
      throw new Error('renderer failed');
    });
    try {
      assert.equal(
        githubNotificationPullRequestOpenedCard({
          repositoryOwner: 'owner',
          repositoryName: 'repo',
          pullRequestNumber: 7,
        }),
        'Pull request: https://github.com/owner/repo/pull/7',
      );
    } finally {
      stub.mock.restore();
    }
  });
});
