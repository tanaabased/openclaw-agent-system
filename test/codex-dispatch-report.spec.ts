import assert from 'node:assert/strict';
import prepareDispatchReport from '../agent/codex-dispatch-report.ts';
import type { DispatchState, DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

const state: DispatchState = { version: 1, scope: 'scope', records: [] };
const intake: IntakeState = {
  version: 1,
  scope: 'scope',
  workspaceDir: '/workspace',
  agentId: 'agent',
  account: { login: 'agent', nodeId: 'actor' },
  policyDigest: 'policy',
  baselineAt: 0,
  records: [],
};
const input = {
  state,
  intake,
  slots: 2,
  automationId: 'intake',
  currentTimeIso: '2026-10-12T12:00:00.000Z',
};
describe('agent/codex-dispatch-report', () => {
  it('should render quiet counts using the existing message rotation', () => {
    const report = prepareDispatchReport(input);
    assert.match(report.response, /DONT_NOTIFY/);
    assert.match(report.response, /Managing:\*\* 0 issues/);
    assert.match(report.response, /Pending:\*\* 0/);
    assert.match(report.response, /Slots:\*\* 0\/2 occupied/);
    assert.deepEqual(report.started, []);
  });
  it('should report an intake failure and recovery without repeating notifications', () => {
    const blocked = {
      ...intake,
      blocker: { code: 'intake-provider-unavailable', since: 1, retryAfter: 2 },
    };
    const first = prepareDispatchReport({ ...input, intake: blocked });
    assert.match(first.response, /NOTIFY/);
    assert.match(first.response, /⚠️/);
    const next = { ...state, intakeHealth: first.health };
    assert.match(
      prepareDispatchReport({ ...input, state: next, intake: blocked }).response,
      /DONT_NOTIFY/,
    );
    const recovered = prepareDispatchReport({ ...input, state: next });
    assert.match(recovered.response, /Intake resumed/);
    assert.equal(recovered.health, '');
  });
  it('should report only verified feedback sends and keep response contents out of intake', () => {
    const record = {
      id: 'owner',
      intakeId: 'assignment',
      phase: 'complete',
      request: {},
      effective: {},
      threadId: 'chat',
      feedback: {
        baseline: {},
        events: [
          {
            id: 'sent',
            phase: 'running',
            attempt: { turnId: 'native-turn' },
            result: { privateText: 'PRIVATE', publicText: 'PUBLIC' },
          },
          { id: 'unsent', phase: 'queued' },
        ],
      },
    } as DispatchRecord;
    const first = prepareDispatchReport({
      ...input,
      slots: 3,
      state: { ...state, records: [record] },
    });
    assert.deepEqual(first.sent, ['sent']);
    assert.match(first.response, /1 feedback item delivered to chats/);
    assert.match(first.response, /Queued feedback:\*\* 1 item across 1 issue/);
    assert.match(first.response, /Slots:\*\* 1\/3 occupied/);
    assert.doesNotMatch(first.response, /PRIVATE|PUBLIC/);
    record.feedback!.events.push({ ...record.feedback!.events[0]!, id: 'second' });
    const grouped = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.deepEqual(grouped.sent, ['sent', 'second']);
    assert.equal(grouped.response.match(/codex:\/\/threads\/chat/g)?.length, 1);
    assert.match(grouped.response, /2 items/);
    record.feedback!.events[2]!.reported = true;
    record.feedback!.events[0]!.reported = true;
    const repeated = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(repeated.response, /DONT_NOTIFY/);
    assert.deepEqual(repeated.sent, []);
  });
  it('should distinguish failed intake state from a temporary provider warning', () => {
    const report = prepareDispatchReport({
      ...input,
      intake: { ...intake, blocker: { code: 'intake-state-invalid', since: 1, retryAfter: 2 } },
    });
    assert.match(report.response, /❌/);
    assert.match(report.response, /intake-state-invalid/);
  });
  it('should keep inactive historical assignments out of feedback intake warnings', () => {
    const record = {
      id: 'historical',
      phase: 'complete',
      feedback: {
        baseline: {},
        events: [],
        code: 'dispatch-assignment-authority-revoked',
      },
    } as unknown as DispatchRecord;
    const quiet = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(quiet.response, /DONT_NOTIFY/);
    assert.doesNotMatch(quiet.response, /authority-revoked/);
    record.feedback!.events.push({ id: 'waiting', phase: 'queued' } as never);
    const pending = prepareDispatchReport({ ...input, state: { ...state, records: [record] } });
    assert.match(pending.response, /authority-revoked/);
    assert.notEqual(pending.health, '');
  });
});
