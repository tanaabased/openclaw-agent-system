import assert from 'node:assert/strict';
import prepareDispatchReport from '../agent/codex-dispatch-report.ts';
import type { DispatchState } from '../agent/codex-dispatch-state.ts';
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
  it('should distinguish failed intake state from a temporary provider warning', () => {
    const report = prepareDispatchReport({
      ...input,
      intake: { ...intake, blocker: { code: 'intake-state-invalid', since: 1, retryAfter: 2 } },
    });
    assert.match(report.response, /❌/);
    assert.match(report.response, /intake-state-invalid/);
  });
});
