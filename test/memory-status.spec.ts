import assert from 'node:assert/strict';

import {
  classifyMemoryEmbeddingFailure,
  memoryIndexState,
  parseMemoryStatus,
} from '../agent/memory-status.ts';

describe('agent/memory-status', () => {
  it('should parse one bounded agent status row', () => {
    const result = parseMemoryStatus(
      JSON.stringify([
        {
          agentId: 'emori',
          status: {
            backend: 'builtin',
            provider: 'openai',
            requestedProvider: 'openai',
            fts: { enabled: true, available: true, error: 'ignored' },
            vector: {
              enabled: true,
              storeAvailable: true,
              semanticAvailable: true,
              index: { state: 'complete' },
              loadError: 'ignored',
            },
            custom: { indexIdentity: { status: 'matched' } },
          },
          embeddingProbe: { ok: true, checked: true },
        },
      ]),
      'emori',
    );

    assert.deepEqual(result, {
      status: {
        provider: 'openai',
        requestedProvider: 'openai',
        fts: { enabled: true, available: true },
        vector: {
          enabled: true,
          storeAvailable: true,
          semanticAvailable: true,
          index: { state: 'complete' },
        },
        custom: { indexIdentity: { status: 'matched' } },
      },
      embeddingProbe: { ok: true, checked: true },
    });
  });

  it('should reject missing, malformed, and cross-agent rows', () => {
    for (const source of ['{}', '[]', '[{"agentId":"leia","status":{"provider":"none"}}]']) {
      assert.throws(() => parseMemoryStatus(source, 'emori'));
    }
  });

  it('should classify provider failures without returning their prose', () => {
    assert.equal(classifyMemoryEmbeddingFailure('insufficient_quota PRIVATE'), 'billing-or-quota');
    assert.equal(classifyMemoryEmbeddingFailure('401 invalid api key PRIVATE'), 'authentication');
    assert.equal(classifyMemoryEmbeddingFailure('403 permission denied PRIVATE'), 'permission');
    assert.equal(classifyMemoryEmbeddingFailure('network timeout PRIVATE'), 'transport');
    assert.equal(classifyMemoryEmbeddingFailure('PRIVATE'), 'unknown');
  });

  it('should prefer explicit index identity failures over persisted state', () => {
    assert.equal(
      memoryIndexState({
        provider: 'openai',
        vector: { enabled: true, index: { state: 'complete' } },
        custom: { indexIdentity: { status: 'mismatched' } },
      }),
      'mismatched',
    );
  });
});
