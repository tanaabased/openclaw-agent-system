import assert from 'node:assert/strict';
import { dispatchRetryDue, scheduleDispatchRetry } from '../agent/dispatch-retry.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/dispatch-retry', () => {
  it('should back off and exhaust five failed attempts without cycling the budget on new codes', () => {
    const record = {} as SharedDispatchRecord;
    let now = 100;
    for (let attempt = 1; attempt <= 5; attempt++) {
      assert.equal(
        scheduleDispatchRetry(
          record,
          attempt % 2 ? 'dispatch-host-unavailable' : 'private-state-file-lock-busy',
          undefined,
          now,
        ),
        true,
      );
      assert.equal(record.retry?.attempts, attempt);
      assert.equal(dispatchRetryDue(record, now), false);
      if (attempt < 5) {
        assert.equal(record.retryAfter, now + 300000 * 2 ** (attempt - 1));
        now = record.retryAfter!;
        assert.equal(dispatchRetryDue(record, now), true);
      } else assert.equal(record.retryAfter, undefined);
    }
  });
  it('should honor provider cooldown and never retry authentication or permission denials', () => {
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
    for (const classification of ['authentication', 'permission', 'unknown'] as const) {
      diagnostic.classification = classification;
      assert.equal(
        scheduleDispatchRetry(
          record,
          'dispatch-host-unavailable',
          { providerDiagnostic: diagnostic },
          1,
        ),
        false,
      );
    }
    assert.equal(scheduleDispatchRetry(record, 'dispatch-creation-denied', undefined, 1), false);
  });
});
