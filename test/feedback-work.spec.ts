import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import {
  beginFeedbackWork,
  feedbackMode,
  feedbackWorkContext,
  feedbackWorkStarted,
} from '../agent/feedback-work.ts';
import issueProgression from '../agent/issue-progression.ts';
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
  name: 'agent-system:agent-system-task-implementation',
  path: '/trusted/SKILL.md',
  scope: 'user',
  digest: 'd'.repeat(64),
};
describe('agent/feedback-work', () => {
  it('should preserve an explicit manual plan mode while using the shared feedback transition', () => {
    const policy = intakeFixture().policy;
    const record = { manualIssue: { selections: { mode: 'plan' as const } } };
    assert.equal(
      feedbackMode(record, {
        ...policy,
        issueAssignment: { ...policy.issueAssignment!, mode: 'work' },
      }),
      'plan',
    );
    assert.equal(
      feedbackMode(
        { ...record, progression: { stage: 'implementation', via: 'operator', enteredAt: 1 } },
        policy,
      ),
      'work',
    );
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
  for (const mode of ['plan', 'auto'] as const)
    for (const scenario of ['implementation request', 'clarification answer', 'follow-up repair'])
      it(`should use the same inputs and transition for direct or approved ${scenario} in ${mode}`, async () => {
        const record: Parameters<typeof beginFeedbackWork>[0]['record'] = {
          createdAt: 1,
          result: {
            outcome: scenario === 'clarification answer' ? 'clarification-needed' : 'plan-ready',
            decision: { mode: 'plan' },
          },
          ...(scenario !== 'implementation request'
            ? {
                progression: {
                  stage: 'implementation' as const,
                  via: 'work' as const,
                  enteredAt: 5,
                },
              }
            : {}),
        };
        const original = structuredClone(record.result);
        const policy = intakeFixture().policy;
        policy.issueAssignment!.mode = mode;
        const direct = issueProgression(record, { mode, operator: true, now: 20 });
        const event = eventFixture();
        await beginFeedbackWork({
          record,
          event,
          policy,
          workspace: '/unused',
          now: 20,
          resolveSkill: async () => skill,
        });
        assert.equal(direct.status, 'ready');
        assert.deepEqual(record.progression, {
          ...(direct.status === 'ready' ? direct.progression : {}),
          workOwner: event.id,
        });
        assert.deepEqual(record.result, original);
        assert.equal(event.work?.decision, undefined);
        assert.equal(policy.issueAssignment!.mode, mode);
      });

  it('should treat an omitted issue mode as auto for new feedback work', () => {
    const { policy } = intakeFixture();
    policy.issueAssignment!.mode = undefined as never;

    assert.equal(feedbackMode({} as never, policy), 'auto');
  });

  it('should stop historical feedback from suppressing current issue recovery', () => {
    const record = { progression: { workOwner: 'issue' }, feedback: { events: [{ work: {} }] } };
    assert.equal(feedbackWorkStarted(record), false);
    record.progression.workOwner = 'feedback';
    assert.equal(feedbackWorkStarted(record), true);
    assert.equal(feedbackWorkStarted({}), false);
  });
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
    await beginFeedbackWork(input);
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
    assert.deepEqual(record.progression, {
      stage: 'implementation',
      via: 'auto',
      enteredAt: 20,
      workOwner: event.id,
    });
    assert.deepEqual(event.work?.decision, decision);
    assert.ok(Value.Check(feedbackSourceEventSchema, event));
    policy.issueAssignment!.mode = 'plan';
    assert.equal(feedbackMode(record, policy), 'work');
    record.retirement = { reason: 'unassigned' };
    assert.throws(() => feedbackMode(record, policy), /feedback-issue-inactive/u);
  });
  it('should refresh implementation selection for the next feedback context without replacing its plan', async () => {
    const record = { createdAt: 1, result: { outcome: 'plan-ready' } };
    const event = eventFixture();
    const policy = intakeFixture().policy;
    policy.issueAssignment!.mode = 'work';
    const input = {
      record,
      event,
      policy,
      workspace: '/unused',
      now: 20,
      resolveSkill: async (id: string) => ({ ...skill, name: id }),
    };
    await beginFeedbackWork(input);
    policy.issueAssignment!.implementation = {
      skill: 'company:updated',
      guidance: 'New guidance.',
    };
    const selected = await beginFeedbackWork(input);
    assert.equal(selected.requestedSkill, 'company:updated');
    assert.equal(selected.guidance?.content, 'New guidance.');
    assert.equal(record.result.outcome, 'plan-ready');
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
      assert.equal(openClawWorkSlot(record, 'work'), undefined);
    }
  });
});
