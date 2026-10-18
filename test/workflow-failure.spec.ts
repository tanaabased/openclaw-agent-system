import assert from 'node:assert/strict';
import workflowFailure, { workflowFailureScope } from '../agent/workflow-failure.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { scheduleDispatchRetry, dispatchFailurePhase } from '../agent/dispatch-retry.ts';

describe('agent/workflow-failure', () => {
  it('should preserve provider codes and retry evidence through delivery wrappers', () => {
    const cause = Object.assign(new Error('provider details'), {
      code: 'github-rate-limited',
      providerDiagnostic: providerDiagnostic('github', 'api-request', 'rate-limit', {
        resetAt: 900000,
      }),
    });
    const error = new Error('delivery failed', { cause });
    const failure = workflowFailure(error, 'workflow-operation-failed');
    assert.equal(failure.code, 'github-rate-limited');
    assert.equal(failure.providerDiagnostic?.resetAt, 900000);
    const record: { retryAfter?: number } = {};
    assert.equal(scheduleDispatchRetry(record, failure.code, error, 0), true);
    assert.equal(record.retryAfter, 900000);
    assert.equal(dispatchFailurePhase(record, failure.code, error), 'retrying');
  });
  it('should retain the outer operation code and the inner permission evidence', () => {
    const cause = { providerDiagnostic: providerDiagnostic('github', 'api-request', 'permission') };
    const error = Object.assign(new Error('wrapped', { cause }), {
      code: 'delivery-provider-failed',
    });
    const failure = workflowFailure(error, 'workflow-operation-failed');
    assert.equal(failure.code, 'delivery-provider-failed');
    assert.equal(dispatchFailurePhase({}, failure.code, error), 'blocked');
    assert.equal(scheduleDispatchRetry({}, failure.code, error, 0), false);
  });
  it('should bound cyclic causes and avoid classifying unknown errors as host failures', () => {
    const error = new Error('raw upstream data');
    error.cause = error;
    assert.deepEqual(workflowFailure(error, 'workflow-operation-failed'), {
      code: 'workflow-operation-failed',
    });
  });
  it('should rebuild provider evidence without retaining extra or unsafe fields', () => {
    const failure = workflowFailure(
      {
        providerDiagnostic: {
          ...providerDiagnostic('github', 'api-request', 'transport'),
          explanation: 'untrusted replacement',
          token: 'SECRET',
          retryAfterMs: -1,
        },
      },
      'workflow-operation-failed',
    );
    assert.equal(failure.providerDiagnostic?.retryAfterMs, null);
    assert.ok(!JSON.stringify(failure).includes('SECRET'));
    assert.ok(!JSON.stringify(failure).includes('untrusted replacement'));
  });
  it('should scope failures without copying private request content', () => {
    assert.deepEqual(
      workflowFailureScope('codex', 'continuation', {
        action: 'delivery',
        id: 'a'.repeat(64),
        eventId: 'b'.repeat(64),
        delivery: { action: 'publish', body: 'PRIVATE' },
        prompt: 'PRIVATE',
      }),
      {
        runtime: 'codex',
        operation: 'continuation:delivery:publish',
        id: 'a'.repeat(64),
        eventId: 'b'.repeat(64),
      },
    );
    assert.deepEqual(
      workflowFailureScope('openclaw', 'dispatch', {
        action: 'PRIVATE',
        id: 'PRIVATE',
        eventId: 'PRIVATE',
        operation: 'PRIVATE',
      }),
      { runtime: 'openclaw', operation: 'dispatch' },
    );
  });
});
