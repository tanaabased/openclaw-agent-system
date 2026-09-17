import assert from 'node:assert/strict';

import parseModelCatalogRows from '../agent/model-catalog.ts';

describe('agent/model-catalog', () => {
  it('should accept omitted missing flags without losing availability evidence', () => {
    const models = [
      { key: 'openai/ready', available: true },
      { key: 'openai/unavailable', available: false },
      { key: 'openai/unknown', available: null },
    ];

    assert.deepEqual(
      parseModelCatalogRows(JSON.stringify({ models })),
      models.map((row) => ({ ...row, missing: false })),
    );
  });

  it('should preserve explicit missing flags and ignore unrelated metadata', () => {
    const models = [
      { key: 'openai/ready', available: true, missing: false, name: 'Ready' },
      { key: 'openai/missing', available: null, missing: true },
    ];

    assert.deepEqual(parseModelCatalogRows(JSON.stringify({ count: 2, models })), [
      { key: 'openai/ready', available: true, missing: false },
      { key: 'openai/missing', available: null, missing: true },
    ]);
  });

  it('should reject malformed evidence instead of claiming model health', () => {
    for (const value of [
      null,
      {},
      { models: {} },
      { models: [null] },
      { models: [{ key: 1, available: true }] },
      { models: [{ key: 'openai/ready' }] },
      { models: [{ key: 'openai/ready', available: 'true' }] },
      { models: [{ key: 'openai/ready', available: true, missing: null }] },
      { models: [{ key: 'openai/ready', available: true, missing: 'false' }] },
    ]) {
      assert.throws(() => parseModelCatalogRows(JSON.stringify(value)));
    }
    assert.throws(() => parseModelCatalogRows('not json'));
  });
});
