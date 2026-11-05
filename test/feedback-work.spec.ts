import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import { feedbackConversationMode, feedbackWorkContext } from '../agent/feedback-work.ts';
import { feedbackSourceEventSchema, type FeedbackSourceEvent } from '../agent/feedback-state.ts';
import { openClawWorkSlot } from '../agent/openclaw-continuation.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { intakeFixture } from './github-intake-fixture.ts';

const eventFixture = (): FeedbackSourceEvent => ({
  id: 'a'.repeat(64),
  sourceId: 'comment',
  nodeId: 'issue',
  number: 3,
  itemType: 'issue',
  source: '{}',
  revision: 'b'.repeat(64),
  createdAt: 10,
  policyDigest: 'c'.repeat(64),
  phase: 'running',
});
describe('agent/feedback-work', () => {
  it('should preserve an explicit manual plan mode while using the shared feedback transition', () => {
    const policy = intakeFixture().policy;
    const record = { manualIssue: { selections: { mode: 'plan' as const } } };
    assert.equal(
      feedbackConversationMode(record, {
        ...policy,
        issueAssignment: { ...policy.issueAssignment!, mode: 'work' },
      }),
      'plan',
    );
    assert.equal(
      feedbackConversationMode(
        { ...record, progression: { stage: 'implementation', via: 'operator', enteredAt: 1 } },
        policy,
      ),
      'work',
    );
  });
  it('should retain conversation context when implementation was cancelled', () => {
    const record = {
      manualIssue: { selections: { mode: 'plan' as const } },
      continuation: { phase: 'cancelled' },
    };
    assert.equal(feedbackConversationMode(record, intakeFixture().policy), 'plan');
  });

  it('should preserve earlier plan revisions and partial work before interpreting another message', () => {
    const revision = {
      ...eventFixture(),
      result: { privateText: 'Use the smaller approach and retain the existing PR.' },
    };
    const partial = {
      ...eventFixture(),
      id: 'c'.repeat(64),
      work: {
        selection: {} as never,
        decision: {
          mode: 'work' as const,
          reasons: ['Requested.'],
          plan: 'Change only the parser.',
        },
        result: {
          outcome: 'clarification-needed' as const,
          summary: 'Choose a value.',
          fullResult: 'Parser changes are retained.',
          questions: ['Which value?'],
        },
      },
    };
    const current = {
      ...eventFixture(),
      id: 'd'.repeat(64),
      result: { privateText: 'Current answer.' },
    };
    const record = { feedback: { events: [revision, partial, current] } };
    const before = structuredClone(record);
    const context = feedbackWorkContext(record, current.id);
    assert.equal(context.length, 2);
    assert.equal(context[0]!.privateText, revision.result.privateText);
    assert.deepEqual(context[1]!.decision, partial.work.decision);
    assert.deepEqual(context[1]!.result, partial.work.result);
    assert.deepEqual(feedbackWorkContext(record).slice(0, 2), context);
    assert.deepEqual(record, before);
    assert.deepEqual(feedbackWorkContext({}), []);
  });
  it('should preserve legacy feedback history without creating another work owner', () => {
    const event = eventFixture();
    assert.ok(Value.Check(feedbackSourceEventSchema, event));
  });
  it('should not start the original openclaw plan again after feedback takes implementation', () => {
    const record = {
      createdAt: 1,
      sessionCreation: { verified: true },
      assessmentTurn: { status: 'completed' },
      result: { outcome: 'plan-ready' },
    } as OpenClawDispatchRecord;
    assert.equal(openClawWorkSlot(record), undefined);
    const event = eventFixture();
    event.work = { selection: {} as never };
    record.feedback = { baseline: {}, events: [event] };
    record.progression = { stage: 'implementation', via: 'work', workOwner: event.id };
    for (const outcome of [undefined, 'done', 'blocked', 'clarification-needed'] as const) {
      event.work.result = outcome
        ? ({
            outcome,
            summary: 'Outcome',
            fullResult: 'Evidence',
            ...(outcome === 'clarification-needed' ? { questions: ['Which value?'] } : {}),
          } as NonNullable<typeof event.work.result>)
        : undefined;
      assert.equal(openClawWorkSlot(record), undefined);
    }
  });
});
