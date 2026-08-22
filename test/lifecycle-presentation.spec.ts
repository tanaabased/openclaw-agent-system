import assert from 'node:assert/strict';

import lifecyclePresentationLines from '../core/lifecycle-presentation.ts';

describe('core/lifecycle-presentation', () => {
  it('should map lifecycle statuses to semantic summary styles', () => {
    const statuses = [
      'blocked',
      'created',
      'drift',
      'healthy',
      'manual',
      'removed',
      'unchanged',
      'updated',
      'valid',
      'warning',
    ] as const;

    assert.deepEqual(
      lifecyclePresentationLines(
        statuses.map((status) => ({ component: 'github', message: status, status })),
      ).map(({ style }) => style),
      [
        'error',
        'action',
        'warning',
        'status',
        'field',
        'action',
        'status',
        'action',
        'status',
        'warning',
      ],
    );
  });
});
