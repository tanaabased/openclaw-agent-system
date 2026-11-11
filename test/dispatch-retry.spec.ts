import assert from 'node:assert/strict';
import {
  dispatchFailurePhase,
  dispatchFailureStatus,
  dispatchRetryDue,
  repositoryPreparationFailure,
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

  it('should recheck known prerequisites and native custody at a bounded cadence', () => {
    for (const code of [
      'model-routing-not-configured',
      'model-routing-profile-missing',
      'model-routing-instructions-changed',
      'model-routing-xhigh-unjustified',
      'codex-model-provider-unsupported',
      'dispatch-configured-project-missing',
      'dispatch-assessment-skill-ambiguous',
      'dispatch-project-inventory-invalid',
      'dispatch-project-ambiguous',
      'dispatch-project-inventory-unavailable',
      'dispatch-project-workspace-required',
      'dispatch-project-registration-unavailable',
      'dispatch-assessment-skill-unavailable',
      'dispatch-assessment-guidance-unreadable',
      'workflow-stage-skill-unavailable',
      'dispatch-creation-unresolved',
      'dispatch-assignment-superseded',
    ]) {
      const record = {} as SharedDispatchRecord;
      for (const now of [0, 300000, 600000]) {
        assert.equal(scheduleDispatchRetry(record, code, undefined, now), true);
        assert.equal(record.retryAfter, now + 300000);
        assert.equal(dispatchRetryDue(record, now), false);
        assert.equal(dispatchRetryDue(record, now + 300000), true);
      }
      assert.equal(
        scheduleDispatchRetry(record, 'dispatch-creation-denied', undefined, 900000),
        false,
      );
      assert.equal(record.retry, undefined);
      assert.equal(record.retryAfter, undefined);
    }
  });

  it('should recheck unclassified local inventory failures without retrying arbitrary failures', () => {
    const record = {} as SharedDispatchRecord;
    const diagnostic = providerDiagnostic('git', 'git-command', 'unknown', {
      providerMessage: 'fatal: bad config line 1 in file .git/config',
      retryAfterMs: 600000,
    });
    for (const now of [0, 600000, 1200000]) {
      assert.equal(
        scheduleDispatchRetry(
          record,
          'dispatch-project-inventory-unavailable',
          {
            cause: { providerDiagnostic: diagnostic },
          },
          now,
        ),
        true,
      );
      assert.equal(record.retryAfter, now + 600000);
      assert.deepEqual(record.providerDiagnostic, diagnostic);
    }
    for (const code of ['unclassified-failure', 'dispatch-creation-denied']) {
      assert.equal(
        scheduleDispatchRetry(record, code, { providerDiagnostic: diagnostic }, 0),
        false,
      );
      assert.equal(record.retryAfter, undefined);
    }
  });

  it('should recheck repository failures only within preparation and retain provider backoff', () => {
    const diagnostic = providerDiagnostic('git', 'git-command', 'unknown');
    for (const code of [
      'dispatch-project-git-unavailable',
      'repository-git-unavailable',
      'git-fetch-lock-exit-128',
      'git-clone-disk-full-exit-128',
      'git-worktree-preparation-unknown-exit-1',
      'repository-path-unsafe',
      'repository-path-missing',
      'repository-io-unavailable',
      'repository-clone-interrupted',
      'repository-workspace-interrupted',
      'dispatch-project-path-unsafe',
      'dispatch-starting-ref-invalid',
    ]) {
      const record = { blocker: code } as SharedDispatchRecord;
      assert.equal(dispatchRetryDue(record, 1), false);
      assert.equal(dispatchRetryDue(record, 1, true), true);
      const error = code.includes('git') ? { providerDiagnostic: diagnostic } : undefined;
      assert.equal(scheduleDispatchRetry(record, code, error, 0), false);
      for (const now of [0, 300000, 600000]) {
        assert.equal(scheduleDispatchRetry(record, code, error, now, true), true);
        assert.equal(record.retryAfter, now + 300000);
      }
    }
    for (const code of [
      'repository-identity-conflict',
      'repository-path-conflict',
      'repository-preparation-changed',
      'git-worktree-owner-mismatch',
      'git-worktree-branch-exists',
      'git-worktree-path-occupied',
      'launch-pr-head-changed',
      'dispatch-operation-cancelled',
      'dispatch-creation-denied',
      'unclassified-failure',
    ]) {
      const record = { blocker: code } as SharedDispatchRecord;
      assert.equal(dispatchRetryDue(record, 1, true), false);
      assert.equal(scheduleDispatchRetry(record, code, undefined, 0, true), false);
    }
    const record = {} as SharedDispatchRecord;
    const error = {
      providerDiagnostic: providerDiagnostic('git', 'git-command', 'rate-limit', {
        resetAt: 900000,
      }),
    };
    assert.equal(scheduleDispatchRetry(record, 'git-fetch-unknown-exit-128', error, 0, true), true);
    assert.equal(record.retryAfter, 900000);
  });

  it('should retain repairable filesystem failures without masking host access or authority errors', () => {
    for (const code of [
      'ENOSPC',
      'EDQUOT',
      'EROFS',
      'EMFILE',
      'ENFILE',
      'EIO',
      'EBUSY',
      'ENOENT',
      'EEXIST',
      'ENOTDIR',
    ]) {
      const original = Object.assign(new Error('local I/O failed'), { code });
      const error = repositoryPreparationFailure(original) as Error;
      assert.equal(error.message, 'repository-io-unavailable');
      assert.equal(error.cause, original);
    }
    for (const code of [
      'EPERM',
      'EACCES',
      'repository-identity-conflict',
      'dispatch-creation-denied',
    ]) {
      const error = Object.assign(new Error(code), { code });
      assert.equal(repositoryPreparationFailure(error), error);
    }
  });

  it('should reserve durable blockers for decisions and authority loss', () => {
    const record = {} as SharedDispatchRecord;
    for (const code of [
      'dispatch-creation-denied',
      'delivery-branch-changed',
      'feedback-source-author-changed',
      'dispatch-turn-cancelled',
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
  it('should reconsider retained prerequisite failures without adding migration metadata', () => {
    const record = {} as SharedDispatchRecord;
    for (const blocker of [
      'model-routing-not-configured',
      'codex-model-provider-unsupported',
      'dispatch-project-ambiguous',
      'dispatch-project-inventory-unavailable',
      'dispatch-project-workspace-required',
    ]) {
      record.blocker = blocker;
      assert.equal(dispatchRetryDue(record, 1), true);
      assert.equal(record.retry, undefined);
    }
    record.blocker = 'dispatch-creation-denied';
    assert.equal(dispatchRetryDue(record, 1), false);
    record.blocker = 'unknown-error';
    assert.equal(dispatchRetryDue(record, 1), false);
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
