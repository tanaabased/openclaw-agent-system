import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import codexContextRequest from '../agent/tasks/context/codex-context-request.ts';
import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';
import type { FeedbackSourceEvent } from '../agent/tasks/feedback/feedback-state.ts';
import type { ManagedIssue } from '../agent/tasks/managed-issue.ts';
import nativeFeedbackPublication from '../agent/tasks/feedback/native-feedback-publication.ts';
import nativeFeedbackReconciliation from '../agent/tasks/feedback/native-feedback-reconciliation.ts';
import nativeFeedbackSource from '../agent/tasks/feedback/native-feedback-source.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

const events = [41, 42].map((number) => ({
  id: String(number),
  number: 7,
  itemType: 'issue',
  source: JSON.stringify({ databaseId: number }),
})) as FeedbackSourceEvent[];
const source = 'https://github.com/owner/repo/issues/7#issuecomment-41';

describe('native feedback source selection', () => {
  it('selects operator publication by exact source and retained text without accepting bindings', () => {
    const issue = {
      id: 'admission',
      repository: { owner: { login: 'owner' }, name: 'repo' },
    } as ManagedIssue;
    const event = {
      ...events[0]!,
      result: { privateText: 'private answer', publicText: 'the exact answer' },
    };
    const record = {
      id: 'task',
      intakeId: 'admission',
      feedback: { events: [event] },
    } as SharedDispatchRecord & { feedback: { events: (typeof event)[] } };
    const input = { action: 'publish-approved', source, publicText: 'the exact answer' };
    assert.deepEqual(nativeFeedbackPublication(input, [record], [issue]), {
      action: 'publish-approved',
      id: 'task',
      eventId: '41',
      apply: true,
      publicText: input.publicText,
    });
    assert.equal(
      nativeFeedbackPublication(
        { action: 'publish-approved', source, preview: true },
        [record],
        [issue],
      ).apply,
      false,
    );
    for (const key of ['id', 'eventId', 'digest', 'apply'])
      assert.throws(
        () => nativeFeedbackPublication({ ...input, [key]: 'override' }, [record], [issue]),
        /override/,
      );
    assert.throws(
      () => nativeFeedbackPublication({ ...input, publicText: 'different' }, [record], [issue]),
      /not-admitted/,
    );
    assert.throws(
      () => nativeFeedbackPublication(input, [record, { ...record, id: 'second' }], [issue]),
      /ambiguous/,
    );
    assert.throws(
      () =>
        nativeFeedbackPublication(
          input,
          [{ ...record, reset: { at: 1 } } as typeof record],
          [issue],
        ),
      /not-admitted/,
    );
  });

  it('should reconcile only the coordinators own admitted source without copied task or event ids', () => {
    const issue = {
      id: 'admission',
      repository: { owner: { login: 'owner' }, name: 'repo' },
    } as ManagedIssue;
    const record = {
      id: 'task',
      intakeId: 'admission',
      sourceThreadId: 'coordinator',
      feedback: { events },
    } as SharedDispatchRecord & { feedback: { events: typeof events } };
    assert.deepEqual(nativeFeedbackReconciliation([record], [issue], 'coordinator', source), {
      id: 'task',
      eventId: '41',
    });
    assert.throws(
      () => nativeFeedbackReconciliation([record], [issue], 'other', source),
      /not-admitted/,
    );
    assert.throws(
      () =>
        nativeFeedbackReconciliation(
          [record],
          [issue],
          'coordinator',
          source.replace('comment-41', 'comment-99'),
        ),
      /not-admitted/,
    );
    assert.throws(
      () =>
        nativeFeedbackReconciliation(
          [record, { ...record, id: 'second-task' }],
          [issue],
          'coordinator',
          source,
        ),
      /ambiguous/,
    );
  });

  it('should use the exact native input and require a semantic choice for queued ambiguity', () => {
    assert.equal(nativeFeedbackSource(events, '42', 'owner/repo', undefined), events[1]);
    assert.equal(nativeFeedbackSource(events, undefined, 'owner/repo', source), events[0]);
    assert.throws(
      () => nativeFeedbackSource(events, undefined, 'owner/repo', undefined),
      /selection-required/,
    );
    assert.throws(
      () => nativeFeedbackSource(events, undefined, 'other/repo', source),
      /not-admitted/,
    );
    assert.throws(
      () => nativeFeedbackSource(events, undefined, 'owner/repo', source.split('#')[0]),
      /url-required/,
    );
    const revised = { ...events[0]!, id: 'revision' };
    assert.throws(
      () => nativeFeedbackSource([...events, revised], undefined, 'owner/repo', source),
      /ambiguous/,
    );
    assert.equal(nativeFeedbackSource([...events, revised], '41', 'owner/repo', source), events[0]);
  });

  it('should reject model binding overrides and bind codex feedback without copied ids', async () => {
    const input = { action: 'feedback', operation: 'context', source };
    assert.equal(Value.Check(dispatchModelParameters, input), true);
    for (const field of ['id', 'eventId', 'threadId', 'agentId', 'digest'])
      assert.equal(Value.Check(dispatchModelParameters, { ...input, [field]: '41' }), false);
    const read = async () => ({
      receipt: 'owner',
      feedbackContextRequest: { eventId: '42' },
      record: { feedback: { events } } as never,
      admission: { repository: { owner: { login: 'owner' }, name: 'repo' } } as ManagedIssue,
    });
    assert.deepEqual(
      await codexContextRequest('/data', 'feedback', { action: 'context' }, 'chat', read),
      {
        action: 'context',
        id: 'owner',
        eventId: '42',
      },
    );
    assert.deepEqual(
      await codexContextRequest('/data', 'feedback', { action: 'context', source }, 'chat', read),
      {
        action: 'context',
        id: 'owner',
        eventId: '41',
      },
    );
    await assert.rejects(
      codexContextRequest('/data', 'feedback', { action: 'context', eventId: '42' }, 'chat', read),
      /binding-override/,
    );
    await assert.rejects(
      codexContextRequest(
        '/data',
        'feedback',
        { action: 'context', source: source.replace('/repo/', '/foreign/') },
        'chat',
        read,
      ),
      /not-admitted/,
    );
  });
});
