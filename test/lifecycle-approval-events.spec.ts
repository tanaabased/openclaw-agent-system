import assert from 'node:assert/strict';

import { assertLifecycleChatPending } from '../scripts/lifecycle-approval-events.ts';

describe('scripts/lifecycle-approval-events', () => {
  it('should keep waiting while the matching chat is active', () => {
    assert.doesNotThrow(() =>
      assertLifecycleChatPending(
        [
          { event: 'chat', payload: { runId: 'active', state: 'delta' } },
          { event: 'agent', payload: { runId: 'active', state: 'error' } },
          { event: 'chat', payload: { runId: 'other', state: 'error' } },
          { event: 'chat', payload: null },
        ],
        'active',
      ),
    );
  });

  for (const state of ['error', 'aborted', 'final']) {
    it(`should stop waiting when the matching chat reaches ${state}`, () => {
      assert.throws(
        () =>
          assertLifecycleChatPending(
            [{ event: 'chat', payload: { runId: 'active', state } }],
            'active',
          ),
        new RegExp(`state=${state}`),
      );
    });
  }

  it('should retain the http failure status without exposing provider prose or identifiers', () => {
    for (const errorMessage of [
      'authentication failed, HTTP 403; private-project private-credential',
      'unexpected status 403 Forbidden: private-project url: https://private.invalid/token',
    ]) {
      assert.throws(
        () =>
          assertLifecycleChatPending(
            [{ event: 'chat', payload: { runId: 'active', state: 'error', errorMessage } }],
            'active',
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /state=error httpStatus=403/);
          assert.doesNotMatch(error.message, /private|https:/);
          return true;
        },
      );
    }
  });

  it('should withhold unrecognized failure text', () => {
    assert.throws(
      () =>
        assertLifecycleChatPending(
          [
            {
              event: 'chat',
              payload: { runId: 'active', state: 'error', errorMessage: 'private-credential' },
            },
          ],
          'active',
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /state=error/);
        assert.doesNotMatch(error.message, /private-credential|httpStatus/);
        return true;
      },
    );
  });
});
