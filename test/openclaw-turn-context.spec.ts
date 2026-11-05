import assert from 'node:assert/strict';

import openclawTurnContext from '../agent/openclaw-turn-context.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';

const record = {
  id: 'a'.repeat(64),
  threadId: 'issue',
  context: '{"body":"PRIVATE-GITHUB-FACT"}',
  request: { key: 'issue', agentId: 'receiver' },
  sessionCreation: { verified: true, sessionId: 'incarnation' },
  assessmentTurn: { runId: 'assessment' },
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
  });
  it('should bind native runs without inventing an optional input id', () => {
    const output = openclawTurnContext(record, { ...binding, inputId: undefined })!;
    assert.doesNotMatch(output.appendContext, /PRIVATE-GITHUB-FACT/);
    assert.match(output.appendContext, /"runId":"assessment"/);
    assert.doesNotMatch(output.appendContext, /inputId/);
  });
  it('should leave admitted feedback to its own explicit context contract', () => {
    const feedback = {
      ...structuredClone(record),
      result: { outcome: 'plan-ready', plan: 'RETAINED-PLAN' },
      feedback: { baseline: {}, events: [{ turn: { runId: 'feedback-run' } }] },
    } as OpenClawDispatchRecord;
    assert.equal(openclawTurnContext(feedback, { ...binding, runId: 'feedback-run' }), undefined);
  });
  it('should route an automatic implementation and its later answer through implementation context', () => {
    const working = {
      ...structuredClone(record),
      result: { outcome: 'plan-ready', plan: 'RETAINED-PLAN' },
      progression: { stage: 'implementation', via: 'work' },
      handoff: { at: 1, by: 'intake', turnId: 'implementation' },
      work: {
        assessmentDigest: 'b'.repeat(64),
        turn: { runId: 'implementation', status: 'attempted', message: 'Continue.' },
      },
    } as OpenClawDispatchRecord;
    for (const runId of ['implementation', 'answer']) {
      const output = openclawTurnContext(working, { ...binding, runId })!;
      assert.match(output.appendSystemContext, /implementation-context/);
      assert.match(output.appendContext, /"stage":"implementation"/);
      assert.equal(working.work!.implementation, undefined);
    }
  });
  it('should route native answers after feedback entered implementation without an issue work record', () => {
    const working = {
      ...structuredClone(record),
      result: { outcome: 'clarification-needed', questions: ['Which approach?'] },
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
      result: { outcome: 'plan-ready', plan: 'ORIGINAL-PLAN' },
      progression: { stage: 'implementation', via: 'work' },
      work: {
        result: { outcome: 'done', summary: 'Done.', fullResult: 'OUTDATED-IMPLEMENTATION-PLAN' },
        delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
      },
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(delivered, { ...binding, runId: 'human-question' })!;
    assert.doesNotMatch(output.appendContext, /ORIGINAL-PLAN|OUTDATED-IMPLEMENTATION-PLAN/);
    assert.equal(delivered.work?.result?.outcome, 'done');
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
  it('should retain a fresh input binding without reinjecting the prior assessment', () => {
    const later = {
      ...structuredClone(record),
      result: { outcome: 'plan-ready', plan: 'FULL-RETAINED-PLAN' },
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(later, {
      ...binding,
      runId: 'later',
      inputId: 'later-input',
    })!;
    assert.doesNotMatch(output.appendContext, /FULL-RETAINED-PLAN/);
    assert.match(output.appendContext, /later-input/);
    assert.doesNotMatch(output.appendContext, /previousResultDigest/);
    assert.equal(later.progression, undefined);
    assert.match(output.appendContext, /"runId":"later"/);
  });
});
