import assert from 'node:assert/strict';
import { historyEvictions } from '../agent/cold-history.ts';
import { historyLifetimeMs } from '../agent/history-state.ts';

import retainDispatchHistory, {
  settledFeedback,
  validTerminalRecord,
} from '../agent/retain-dispatch-history.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { FeedbackSourceEvent } from '../agent/feedback-state.ts';
import intakePassStarted from '../agent/intake-pass-started.ts';
import type { OpenClawIntakePass } from '../agent/openclaw-intake-pass.ts';

const id = 'a'.repeat(64);
const selection = {
  version: 1 as const,
  requestedSkill: 'skill',
  defaultSkill: true,
  skill: { name: 'skill', path: '/skill', scope: 'fixture', digest: id },
  observedAt: 1,
};
function record(): OpenClawDispatchRecord {
  return {
    id,
    intakeId: id,
    issueKey: id,
    sourceThreadId: 'intake',
    phase: 'routing',
    createdAt: 1,
    manifestDigest: 'manifest',
    context: 'original detail',
    retired: { at: 10, by: 'intake' },
    retirement: {
      reason: 'issue-closed',
      at: 10,
      eligibleAt: 10,
      checkedAt: 10,
      intakeId: id,
      archivedAt: 10,
      worktreeRemovedAt: 10,
    },
  };
}
function event(index: number): FeedbackSourceEvent {
  return {
    id: index.toString(16).padStart(64, '0'),
    sourceId: 'comment-' + index,
    number: 1,
    nodeId: 'issue',
    itemType: 'issue',
    source: 'exact source',
    revision: id,
    createdAt: 1,
    policyDigest: id,
    phase: 'published',
    receipt: { nodeId: 'reply-' + index, databaseId: index },
    reported: true,
    result: { privateText: 'exact result' },
  };
}

describe('agent/retain-dispatch-history', () => {
  it('should evict oldest cold detail before exceeding the budget, including temporary write space', () => {
    const mib = 1024 * 1024;
    const entries = [
      { name: 'old', at: 1, bytes: 32 * mib },
      { name: 'new', at: 2, bytes: 30 * mib },
    ];
    assert.deepEqual(
      historyEvictions(entries, 10, 4 * mib).map((entry) => entry.name),
      ['old'],
    );
    assert.deepEqual(
      historyEvictions(entries, historyLifetimeMs + 1).map((entry) => entry.name),
      ['old'],
    );
    assert.deepEqual(historyEvictions(entries, 10), []);
  });

  it('should require verified cleanup and preserve the original input', () => {
    const source = record();
    source.worktreeAttemptId = id;
    const before = structuredClone(source);
    const terminal = retainDispatchHistory(source)!;
    assert.equal(terminal.context, undefined);
    assert.equal(terminal.intakeId, source.intakeId);
    assert.equal(terminal.worktreeAttemptId, id);
    assert.equal(validTerminalRecord(terminal), true);
    assert.deepEqual(source, before);
    for (const field of ['worktreeRemovedAt', 'archivedAt'] as const) {
      const pending = record();
      delete pending.retirement![field];
      assert.equal(retainDispatchHistory(pending), undefined);
    }
    const unavailable = record();
    delete unavailable.retirement!.archivedAt;
    unavailable.retirement!.sessionUnavailableObserved = { at: 10, session: 'not-found' };
    assert.ok(retainDispatchHistory(unavailable)?.retainedHistory?.terminal);
  });

  it('should protect unfinished native work and implementation after a published reply', () => {
    const source = record();
    delete source.retired;
    delete source.retirement;
    source.firstTurn = { runId: 'running', message: 'prompt', status: 'accepted' };
    assert.equal(retainDispatchHistory(source), undefined);
    const workEvent = event(1);
    workEvent.work = {
      selection,
      result: { outcome: 'done', summary: 'done', fullResult: 'done' },
    };
    assert.equal(settledFeedback(workEvent), false);
    for (const changed of [
      { ...event(1), reported: false },
      { ...event(1), phase: 'responded' as const },
      { ...event(1), policyHeld: 'denied' },
      { ...event(1), receipt: undefined },
    ])
      assert.equal(settledFeedback(changed), false);
  });

  it('should offload stale turns and unsuccessful outcomes after native cleanup without inventing success', () => {
    const source = record();
    source.firstTurn = {
      runId: 'stale',
      message: 'large prompt',
      status: 'consumed',
      consumedByEventId: 'event',
      cancelled: true,
    };
    source.result = {
      version: 1,
      outcome: 'operator-setup-blocker',
      summary: 'failed',
      fullAssessment: 'full failed plan',
      code: 'setup-unavailable',
      remediation: 'restore setup',
      evidence: [],
      progress: { completed: [], remaining: ['work'] },
    };
    source.directAssessments = [
      {
        id,
        binding: id,
        target: 'issue',
        repositoryId: 'repo',
        subjectId: 'issue',
        checkout: { path: '/worktree', revision: 'head', dirty: false },
        evidence: 'unfinished incidental context',
        selection,
        turnId: 'turn',
        inputId: 'input',
      },
    ];
    source.feedback = {
      baseline: {},
      events: [
        { ...event(1), reported: false },
        {
          ...event(2),
          receipt: undefined,
          publicationAttempted: true,
          policyHeld: 'native-denial',
        },
      ],
    };
    const terminal = retainDispatchHistory(source)!;
    assert.equal(terminal.retainedHistory!.outcome!.assessment, 'operator-setup-blocker');
    assert.equal(terminal.retainedHistory!.outcome!.code, 'setup-unavailable');
    assert.deepEqual(terminal.retainedHistory!.outcome!.assessments, [{ id, outcome: 'missing' }]);
    assert.deepEqual(terminal.retainedHistory!.outcome!.turns, [
      { runId: 'stale', status: 'consumed', consumedByEventId: 'event', cancelled: true },
    ]);
    assert.equal(terminal.retainedHistory!.effects![0]!.reported, false);
    assert.deepEqual(terminal.retainedHistory!.effects![0]!.receipt, event(1).receipt);
    assert.equal(terminal.retainedHistory!.effects![1]!.hold, 'native-denial');
    assert.equal(terminal.feedback, undefined);
    assert.equal(terminal.result, undefined);
    assert.equal(validTerminalRecord(terminal), true);
    assert.equal(source.firstTurn.status, 'consumed');
  });

  it('should reject contradictory native activity and cleanup receipts predating intent', () => {
    for (const source of [
      { ...record(), nativeInactive: false },
      { ...record(), retirement: { ...record().retirement!, worktreeRemovedAt: 9 } },
      {
        ...record(),
        retirement: { ...record().retirement!, archiveAttempt: { at: 11, turnId: 'later' } },
      },
      {
        ...record(),
        retirement: { ...record().retirement!, archiveRequest: { at: 11, sessionId: 'later' } },
      },
      { ...record(), retirement: { ...record().retirement!, deadlinePending: true as const } },
    ])
      assert.equal(retainDispatchHistory(source), undefined);
  });

  it('should preserve replacement links when settled successor history is offloaded', () => {
    const source = { ...record(), predecessorId: 'b'.repeat(64), supersededBy: 'c'.repeat(64) };
    const terminal = retainDispatchHistory(source)!;
    assert.equal(terminal.predecessorId, source.predecessorId);
    assert.equal(terminal.supersededBy, source.supersededBy);
    assert.equal(validTerminalRecord(terminal), true);
  });

  it('should keep the latest context, current work owner and unfinished feedback exact', () => {
    const source = { ...record(), retired: undefined, retirement: undefined };
    source.feedback = { baseline: {}, events: [event(1), event(2), event(3), event(4)] };
    source.feedback.events[2]!.phase = 'responded';
    source.progression = {
      stage: 'implementation',
      via: 'operator',
      enteredAt: 1,
      workOwner: source.feedback.events[1]!.id,
    };
    const projected = retainDispatchHistory(source)!;
    assert.deepEqual(projected.feedback!.events, source.feedback.events.slice(1));
    assert.deepEqual(projected.feedback!.completed, [
      {
        id: event(1).id,
        sourceId: 'comment-1',
        nodeId: 'issue',
        revision: id,
        receipt: { nodeId: 'reply-1', databaseId: 1 },
      },
    ]);
  });

  it('should retain consumed native-run allowance after request bodies leave working state', () => {
    const pass: OpenClawIntakePass = {
      sessionKey: 'intake',
      sessionId: 'session',
      runId: 'run',
      limit: 1,
      allowance: 1,
      candidates: [id],
      recovery: [],
      selected: [id],
      started: [id],
    };
    const terminal = retainDispatchHistory(record())!;
    assert.deepEqual(intakePassStarted(pass, [terminal]), [id]);
    assert.deepEqual(intakePassStarted({ ...pass, recovery: [id] }, [terminal]), []);
  });

  it('should preserve the latest implementation result after a later plain reply', () => {
    const source = { ...record(), retired: undefined, retirement: undefined };
    const implementation = {
      ...event(2),
      work: {
        selection,
        result: {
          outcome: 'done' as const,
          summary: 'implemented',
          fullResult: 'verified changes',
        },
      },
      workDelivery: {
        id,
        binding: {
          repositoryId: 'repo',
          issueId: 'issue',
          sessionId: 'session',
          threadId: 'thread',
          worktree: '/worktree',
          branch: 'work',
          base: 'main',
          head: 'head',
          authorId: 'author',
          policyDigest: id,
        },
        title: 'title',
        body: 'body',
        creationAttempted: true,
        reconciled: true,
        pushedHead: 'head',
        pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 1 },
        announcement: {
          publicationId: 'publication',
          authorId: 'author',
          snapshot: {
            pullRequestNodeId: 'pr',
            pullRequestNumber: 1,
            draft: true,
            head: 'head',
            title: 'title',
            body: 'body',
          },
          composition: selection,
          attempted: true,
          receipt: { nodeId: 'announcement', databaseId: 1 },
        },
      },
    };
    assert.equal(settledFeedback(implementation), true);
    source.feedback = { baseline: {}, events: [event(1), implementation, event(3)] };
    const projected = retainDispatchHistory(source)!;
    assert.deepEqual(projected.feedback!.events, [implementation, event(3)]);
    assert.deepEqual(
      projected.feedback!.completed!.map((entry) => entry.id),
      [event(1).id],
    );
  });
});
