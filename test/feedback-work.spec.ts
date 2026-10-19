import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import { beginFeedbackWork, feedbackMode } from '../agent/feedback-work.ts';
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
const skill = {
  name: 'agent-system:agent-system-issue-implementation',
  path: '/trusted/SKILL.md',
  scope: 'user',
  digest: 'd'.repeat(64),
};
describe('agent/feedback-work', () => {
  it('should preserve old feedback records and leave plan decisions without implementation state', async () => {
    const event = eventFixture();
    assert.ok(Value.Check(feedbackSourceEventSchema, event));
    const record = { createdAt: 1, result: { outcome: 'plan-ready' } };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.mode = 'auto';
    await assert.rejects(
      beginFeedbackWork({
        record,
        event,
        policy,
        workspace: '/unused',
        now: 20,
        decision: { mode: 'plan', reasons: ['Need clarification.'], plan: 'Clarify scope first.' },
        resolveSkill: async () => skill,
      }),
      { reason: 'auto-wait' },
    );
    assert.equal(event.work, undefined);
    assert.deepEqual(record, { createdAt: 1, result: { outcome: 'plan-ready' } });
  });
  it('should use approved feedback direction to enter work from plan without changing defaults', async () => {
    const record: Parameters<typeof beginFeedbackWork>[0]['record'] = {
      createdAt: 1,
      result: { outcome: 'plan-ready' },
    };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.mode = 'plan';
    const event = eventFixture();
    const input = {
      record,
      policy,
      event,
      workspace: '/unused',
      now: 20,
      resolveSkill: async () => skill,
    };
    await assert.rejects(beginFeedbackWork(input), { reason: 'implementation-direction-required' });
    await beginFeedbackWork({
      ...input,
      decision: {
        mode: 'work',
        reasons: ['The approved author explicitly requests implementation.'],
        plan: 'Implement the agreed change.',
      },
    });
    assert.equal(record.progression?.via, 'operator');
    assert.equal(record.progression?.stage, 'implementation');
    assert.equal(policy.issueAssignment!.mode, 'plan');
    assert.equal(record.result?.outcome, 'plan-ready');
    assert.ok(Value.Check(feedbackSourceEventSchema, event));
  });
  it('should retain the first stage and original results while new feedback carries its own plan', async () => {
    const record: Parameters<typeof beginFeedbackWork>[0]['record'] = {
      createdAt: 1,
      result: { outcome: 'clarification-needed' },
    };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.mode = 'auto';
    const event = eventFixture();
    const decision = {
      mode: 'work' as const,
      reasons: ['The answer resolves scope.'],
      plan: 'Implement the agreed bounded change.',
    };
    await beginFeedbackWork({
      record,
      event,
      policy,
      decision,
      workspace: '/unused',
      now: 20,
      resolveSkill: async () => skill,
    });
    assert.deepEqual(record.result, { outcome: 'clarification-needed' });
    assert.deepEqual(record.progression, { stage: 'implementation', via: 'auto', enteredAt: 20 });
    assert.deepEqual(event.work?.decision, decision);
    assert.ok(Value.Check(feedbackSourceEventSchema, event));
    policy.issueAssignment!.mode = 'plan';
    assert.equal(feedbackMode(record, policy), 'work');
    record.retirement = { reason: 'unassigned' };
    assert.throws(() => feedbackMode(record, policy), /feedback-issue-inactive/u);
  });
  it('should not start the original openclaw plan again after feedback takes implementation', () => {
    const record = {
      createdAt: 1,
      sessionCreation: { verified: true },
      assessmentTurn: { status: 'completed' },
      result: { outcome: 'plan-ready' },
    } as OpenClawDispatchRecord;
    assert.equal(openClawWorkSlot(record, 'work'), 'turn');
    const event = eventFixture();
    event.work = { selection: {} as never };
    record.feedback = { baseline: {}, events: [event] };
    for (const outcome of [undefined, 'done', 'blocked', 'clarification-needed'] as const) {
      event.work.result = outcome
        ? ({
            outcome,
            summary: 'Outcome',
            fullResult: 'Evidence',
            ...(outcome === 'clarification-needed' ? { questions: ['Which value?'] } : {}),
          } as NonNullable<typeof event.work.result>)
        : undefined;
      assert.equal(openClawWorkSlot(record, 'work'), undefined);
    }
  });
});
