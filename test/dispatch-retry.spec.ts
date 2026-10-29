import assert from 'node:assert/strict';
import {
  dispatchFailurePhase,
  dispatchFailureStatus,
  dispatchRetryDue,
  scheduleDispatchRetry,
} from '../agent/dispatch-retry.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/dispatch-retry', () => {
  it('should clear obsolete backoff and identify investigation instead of promising a retry', () => {
    const record = {
      retry: { code: 'dispatch-host-unavailable', attempts: 1 },
      retryAfter: 100,
    } as SharedDispatchRecord;
    assert.equal(scheduleDispatchRetry(record, 'unclassified-failure', undefined, 200), false);
    assert.equal(record.retry, undefined);
    assert.equal(record.retryAfter, undefined);
    assert.equal(dispatchFailureStatus(record, 'unclassified-failure'), 'needs-attention');
    assert.equal(dispatchRetryDue(record, 1000), false);
    assert.equal(dispatchFailureStatus(record, 'continuation-native-approval-denied'), 'blocked');
  });

  it('should reserve durable blockers for decisions and authority loss', () => {
    const record = {} as SharedDispatchRecord;
    for (const code of [
      'dispatch-creation-denied',
      'delivery-branch-changed',
      'feedback-source-author-changed',
      'dispatch-turn-cancelled',
      'dispatch-assignment-authority-revoked',
    ])
      assert.equal(dispatchFailurePhase(record, code), 'blocked');
    for (const code of [
      'dispatch-project-registration-unavailable',
      'dispatch-creation-unresolved',
      'dispatch-operation-failed',
      'continuation-skill-identity-changed',
      'continuation-schedule-binding-mismatch',
      'feedback-schedule-owner-changed',
    ])
      assert.equal(dispatchFailurePhase(record, code), 'waiting');
    scheduleDispatchRetry(record, 'dispatch-host-unavailable', undefined, 0);
    assert.equal(dispatchFailurePhase(record, 'dispatch-host-unavailable'), 'retrying');
    record.retry!.attempts = 5;
    assert.equal(dispatchFailurePhase(record, 'dispatch-host-unavailable'), 'retrying');
  });
  it('should cap backoff without requiring manual recovery or cycling on new codes', () => {
    const record = {} as SharedDispatchRecord;
    let now = 100;
    for (let attempt = 1; attempt <= 8; attempt++) {
      assert.equal(
        scheduleDispatchRetry(
          record,
          attempt % 2 ? 'dispatch-host-unavailable' : 'private-state-file-lock-busy',
          undefined,
          now,
        ),
        true,
      );
      assert.equal(record.retry?.attempts, Math.min(attempt, 5));
      assert.equal(dispatchRetryDue(record, now), false);
      assert.equal(record.retryAfter, now + Math.min(300000 * 2 ** (attempt - 1), 3600000));
      now = record.retryAfter!;
      assert.equal(dispatchRetryDue(record, now), true);
    }
  });
  it('should recheck repaired provider access while preserving native denials', () => {
    const record = {} as SharedDispatchRecord;
    const diagnostic = providerDiagnostic('github', 'api-request', 'rate-limit', {
      resetAt: 10000000,
    });
    assert.equal(
      scheduleDispatchRetry(
        record,
        'github-notification-request-failed',
        { providerDiagnostic: diagnostic },
        1,
      ),
      true,
    );
    assert.equal(record.retryAfter, 10000000);
    diagnostic.classification = 'permission';
    assert.equal(
      dispatchFailurePhase(record, 'github-notification-request-failed', {
        providerDiagnostic: diagnostic,
      }),
      'retrying',
    );
    for (const classification of ['authentication', 'permission', 'unknown'] as const) {
      diagnostic.classification = classification;
      assert.equal(
        scheduleDispatchRetry(
          record,
          'dispatch-host-unavailable',
          { providerDiagnostic: diagnostic },
          1,
        ),
        classification !== 'unknown',
      );
    }
    assert.equal(scheduleDispatchRetry(record, 'dispatch-creation-denied', undefined, 1), false);
    diagnostic.classification = 'permission';
    assert.equal(
      scheduleDispatchRetry(
        record,
        'continuation-native-approval-denied',
        { providerDiagnostic: diagnostic },
        1,
      ),
      false,
    );
    assert.equal(
      dispatchFailurePhase(record, 'continuation-native-approval-denied', {
        providerDiagnostic: diagnostic,
      }),
      'blocked',
    );
  });
});
