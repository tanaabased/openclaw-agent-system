import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import openclawTurnContext from '../agent/tasks/context/openclaw-turn-context.ts';

const record = {
  id: 'a'.repeat(64),
  threadId: 'issue',
  context: '{"body":"PRIVATE-GITHUB-FACT"}',
  request: { key: 'issue', agentId: 'receiver' },
  sessionCreation: { verified: true, sessionId: 'incarnation' },
  nativeTurns: [{ role: 'assessment', turn: { runId: 'assessment' } }],
} as OpenClawDispatchRecord;
const binding = {
  agentId: 'receiver',
  sessionKey: 'issue',
  sessionId: 'incarnation',
  runId: 'assessment',
  inputId: 'current-input',
};

describe('agent/openclaw-turn-context', () => {
  it('should bind private facts to the native current input and keep provider data out of trusted instructions', () => {
    const output = openclawTurnContext(record, binding)!;
    assert.doesNotMatch(output.appendContext, /PRIVATE-GITHUB-FACT/);
    assert.match(output.appendContext, /current-input/);
    assert.doesNotMatch(output.appendContext, /BEGIN UNTRUSTED GITHUB PROVIDER DATA/);
    assert.doesNotMatch(output.appendSystemContext, /PRIVATE-GITHUB-FACT/);
    const facts = JSON.parse(output.appendContext.split('\n')[1]!);
    assert.equal(facts.contextRequest, undefined);
    assert.equal(facts.agentId, binding.agentId);
    assert.deepEqual(facts.currentSession, {
      sessionKey: binding.sessionKey,
      sessionId: binding.sessionId,
    });
    assert.match(output.appendSystemContext, /agent_system_context/);
  });
  it('should keep the initial native turn distinct from queued feedback', () => {
    const withFeedback = {
      ...record,
      feedback: {
        baseline: {},
        events: [
          {
            id: 'other',
            itemType: 'issue',
            number: 3,
            source: JSON.stringify({ databaseId: 42 }),
            turn: { runId: 'other-run' },
          },
        ],
      },
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(withFeedback, binding)!;
    assert.equal(JSON.parse(output.appendContext.split('\n')[1]!).stage, 'assessment');
  });
  it('should bind native runs without inventing an optional input id', () => {
    const output = openclawTurnContext(record, { ...binding, inputId: undefined })!;
    assert.doesNotMatch(output.appendContext, /PRIVATE-GITHUB-FACT/);
    assert.match(output.appendContext, /"runId":"assessment"/);
    assert.doesNotMatch(output.appendContext, /inputId/);
  });
  it('should supply a read-only feedback lookup with private instructions and no source prose', () => {
    const feedback = {
      ...structuredClone(record),
      feedback: {
        baseline: {},
        events: [
          {
            id: 'comment',
            source: JSON.stringify({ databaseId: 42, body: 'PRIVATE-COMMENT' }),
            number: 3,
            itemType: 'issue',
            turn: { runId: 'feedback-run' },
          },
        ],
      },
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(feedback, { ...binding, runId: 'feedback-run' })!;
    const facts = JSON.parse(output.appendContext.split('\n')[1]!);
    assert.deepEqual(facts.contextProbe, {
      version: 1,
      runtime: 'openclaw',
      hook: 'before_prompt_build',
    });
    assert.equal(facts.stage, 'feedback');
    assert.equal(facts.feedbackContextRequest, undefined);
    assert.match(output.appendSystemContext, /agent_system_context/);
    assert.doesNotMatch(output.appendSystemContext, /PRIVATE-COMMENT|RETAINED-PLAN/);
    assert.doesNotMatch(output.appendContext, /PRIVATE-COMMENT|RETAINED-PLAN/);
    feedback.feedback!.events[0]!.turn!.executionRunId = 'queued-execution';
    const before = structuredClone(feedback);
    const queued = openclawTurnContext(feedback, { ...binding, runId: 'queued-execution' })!;
    assert.equal(JSON.parse(queued.appendContext.split('\n')[1]!).stage, 'feedback');
    assert.deepEqual(feedback, before);
    assert.doesNotMatch(
      openclawTurnContext(feedback, { ...binding, runId: 'feedback-run' })!.appendContext,
      /feedbackContextRequest/,
    );
  });
  it('should expose explicit source choices without inventing a current-run mapping', () => {
    const events = ['a', 'b'].map((id, index) => ({
      id,
      number: 3,
      itemType: 'issue',
      source: JSON.stringify({ databaseId: index + 42, body: 'PRIVATE-COMMENT' }),
      turn: { runId: id, status: 'accepted' },
    }));
    const output = openclawTurnContext(
      { ...record, feedback: { baseline: {}, events } } as OpenClawDispatchRecord,
      { ...binding, runId: 'queued-execution', repository: 'owner/repo' },
    )!;
    const facts = JSON.parse(output.appendContext.split('\n')[1]!);
    assert.equal(facts.feedbackContextRequest, undefined);
    assert.equal(facts.contextRequest, undefined);
    assert.equal(facts.stage, 'conversation');
    assert.deepEqual(
      facts.availableFeedback.map(
        (entry: { source: { commentId: number } }) => entry.source.commentId,
      ),
      [42, 43],
    );
    assert.equal(
      facts.availableFeedback[1].url,
      'https://github.com/owner/repo/issues/3#issuecomment-43',
    );
    assert.doesNotMatch(output.appendContext, /PRIVATE-COMMENT/);
    const initial = JSON.parse(
      openclawTurnContext(
        { ...record, feedback: { baseline: {}, events } } as OpenClawDispatchRecord,
        binding,
      )!.appendContext.split('\n')[1]!,
    );
    assert.equal(initial.stage, 'assessment');
    assert.equal(initial.contextRequest, undefined);
    for (const event of events) Object.assign(event.turn, { cancelled: true });
    assert.equal(
      JSON.parse(
        openclawTurnContext(
          { ...record, feedback: { baseline: {}, events } } as OpenClawDispatchRecord,
          { ...binding, runId: 'queued-execution' },
        )!.appendContext.split('\n')[1]!,
      ).availableFeedback,
      undefined,
    );
  });
  it('should route an automatic implementation and its later answer through implementation context', () => {
    const working = {
      ...structuredClone(record),
      progression: { stage: 'implementation', via: 'work' },
      handoff: { at: 1, by: 'intake', turnId: 'implementation' },
      work: { implementation: { runId: 'implementation', inputEventId: 'input' } },
    } as OpenClawDispatchRecord;
    for (const runId of ['implementation', 'answer']) {
      const output = openclawTurnContext(working, { ...binding, runId })!;
      assert.match(output.appendSystemContext, /implementation-context/);
      assert.match(output.appendContext, /"stage":"implementation"/);
      assert.equal(working.work!.implementation?.runId, 'implementation');
    }
  });
  it('should route native answers after feedback entered implementation without an issue work record', () => {
    const working = {
      ...structuredClone(record),
      progression: { stage: 'implementation', via: 'work' },
    } as unknown as OpenClawDispatchRecord;
    const output = openclawTurnContext(working, { ...binding, runId: 'answer' })!;
    assert.match(output.appendSystemContext, /implementation-context/);
    assert.doesNotMatch(output.appendContext, /clarification-needed/);
    assert.equal(working.work, undefined);
  });
  it('should retain delivered task facts without gating ordinary human conversation', () => {
    const delivered = {
      ...structuredClone(record),
      progression: { stage: 'implementation', via: 'work' },
      delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
      work: {},
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(delivered, { ...binding, runId: 'human-question' })!;
    assert.doesNotMatch(output.appendContext, /ORIGINAL-PLAN|OUTDATED-IMPLEMENTATION-PLAN/);
  });

  it('should refuse wrong agent, session, incarnation, and missing run', () => {
    for (const change of [
      { agentId: 'other' },
      { sessionKey: 'other' },
      { sessionId: 'replaced' },
      { runId: undefined },
    ])
      assert.equal(openclawTurnContext(record, { ...binding, ...change }), undefined);
  });
});
