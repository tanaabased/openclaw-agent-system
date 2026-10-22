import assert from 'node:assert/strict';
import {
  notificationResetDiagnostic,
  withNotificationResetDiagnostic,
} from '../agent/notification-reset-diagnostic.ts';

describe('agent/notification-reset-diagnostic', () => {
  it('should preserve owned codes from typed errors and redact arbitrary provider details', () => {
    assert.equal(
      notificationResetDiagnostic(
        Object.assign(new Error('sensitive provider text'), {
          code: 'automation-thread-workspace-mismatch',
        }),
      ).code,
      'automation-thread-workspace-mismatch',
    );
    assert.equal(
      notificationResetDiagnostic(new Error('session-dispatch-describe-forbidden')).code,
      'session-dispatch-describe-forbidden',
    );
    assert.deepEqual(notificationResetDiagnostic(new Error('token=private')), {
      code: 'notification-reset-failed',
    });
    assert.equal(
      notificationResetDiagnostic(Object.assign(new Error('/private/file'), { code: 'EACCES' }))
        .code,
      'EACCES',
    );
  });

  it('should retain the most specific failed native operation through enclosing reset stages', async () => {
    await assert.rejects(
      withNotificationResetDiagnostic({ phase: 'drain', operation: 'observe-active-turns' }, () =>
        withNotificationResetDiagnostic(
          {
            phase: 'drain',
            operation: 'sessions.describe',
            resource: { kind: 'chat', description: 'agent:emori:12345678' },
          },
          async () => {
            throw new Error('session-dispatch-describe-forbidden');
          },
        ),
      ),
      (error) => {
        assert.deepEqual(notificationResetDiagnostic(error), {
          code: 'session-dispatch-describe-forbidden',
          phase: 'drain',
          operation: 'sessions.describe',
          resource: { kind: 'chat', description: 'agent:emori:12345678' },
        });
        return true;
      },
    );
  });
});
