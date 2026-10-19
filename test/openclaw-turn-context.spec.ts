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
    assert.match(output.appendContext, /PRIVATE-GITHUB-FACT/);
    assert.match(output.appendContext, /current-input/);
    assert.match(output.appendContext, /BEGIN UNTRUSTED GITHUB PROVIDER DATA/);
    assert.doesNotMatch(output.appendSystemContext, /PRIVATE-GITHUB-FACT/);
    assert.match(output.appendSystemContext, /explicit tool verifies current authority/);
  });
  it('should bind native runs without inventing an optional input id', () => {
    const output = openclawTurnContext(record, { ...binding, inputId: undefined })!;
    assert.match(output.appendContext, /PRIVATE-GITHUB-FACT/);
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
  it('should refuse wrong agent, session, incarnation, missing run and premature later turns', () => {
    for (const change of [
      { agentId: 'other' },
      { sessionKey: 'other' },
      { sessionId: 'replaced' },
      { runId: undefined },
      { runId: 'later' },
    ])
      assert.equal(openclawTurnContext(record, { ...binding, ...change }), undefined);
  });
  it('should recover the complete prior result with a fresh input binding without granting implementation', () => {
    const later = {
      ...structuredClone(record),
      result: { outcome: 'plan-ready', plan: 'FULL-RETAINED-PLAN' },
    } as OpenClawDispatchRecord;
    const output = openclawTurnContext(later, {
      ...binding,
      runId: 'later',
      inputId: 'later-input',
    })!;
    assert.match(output.appendContext, /FULL-RETAINED-PLAN/);
    assert.match(output.appendContext, /later-input/);
    assert.match(output.appendContext, /previousResultDigest/);
    assert.match(output.appendSystemContext, /context/);
    assert.doesNotMatch(output.appendSystemContext, /implementation-context/);
  });
});
