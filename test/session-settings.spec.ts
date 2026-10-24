import assert from 'node:assert/strict';

import sessionSettings from '../agent/session-settings.ts';

describe('agent/session-settings', () => {
  const requested = { model: 'original', effort: 'high' };
  for (const field of ['model', 'effort'] as const)
    it(`should reject initial ${field} divergence but accept tuning after verified creation`, () => {
      const observed = { ...requested, [field]: 'changed' };
      assert.equal(
        sessionSettings({ requested, observed, creationVerified: false }).mismatch,
        field,
      );
      assert.deepEqual(sessionSettings({ requested, observed, creationVerified: true }), {
        mismatch: undefined,
        effective: { status: 'verified', ...observed },
      });
      assert.deepEqual(requested, { model: 'original', effort: 'high' });
    });

  it('should distinguish unavailable native readback from required creation evidence', () => {
    const available = sessionSettings({ requested, observed: {}, creationVerified: false });
    assert.deepEqual(available, { mismatch: undefined, effective: { status: 'unverified' } });
    assert.equal(
      sessionSettings({
        requested,
        observed: {},
        creationVerified: false,
        requireInitialReadback: true,
      }).mismatch,
      'model',
    );
  });

  it('should report current partial or absent settings without inventing requested values', () => {
    assert.deepEqual(
      sessionSettings({ requested, observed: { effort: 'low' }, creationVerified: true }).effective,
      { status: 'unverified', effort: 'low' },
    );
    assert.deepEqual(
      sessionSettings({ requested, observed: {}, creationVerified: true }).effective,
      { status: 'unverified' },
    );
  });
});
