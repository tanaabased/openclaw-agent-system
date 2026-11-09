import assert from 'node:assert/strict';
import nativeFeedbackSource from '../agent/native-feedback-source.ts';
import codexContextRequest from '../agent/codex-context-request.ts';
import type { FeedbackSourceEvent } from '../agent/feedback-state.ts';
import type { ManagedIssue } from '../agent/managed-issue.ts';
import { Value } from 'typebox/value';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

const events = [41, 42].map((number) => ({
  id: String(number),
  number: 7,
  itemType: 'issue',
  source: JSON.stringify({ databaseId: number }),
})) as FeedbackSourceEvent[];
const source = 'https://github.com/owner/repo/issues/7#issuecomment-41';

describe('native feedback source selection', () => {
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
