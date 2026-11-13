import assert from 'node:assert/strict';

import inspectMemoryIndex, {
  inspectMemoryEmbedding,
  type MemoryStatusDependencies,
} from '../agent/lifecycle/inspect-memory-status.ts';

const agentId = 'test-agent';
const refusal = {
  code: 1,
  stdout: '',
  stderr:
    'Cannot admit memory.cli for memory stores: This operation requires exclusive offline state ownership.',
};
const detail = {
  provider: 'openai',
  requestedProvider: 'openai',
  dirty: false,
  fts: { enabled: true, available: true },
  vector: { enabled: true, index: { state: 'complete' } },
  custom: { providerState: { mode: 'pending' }, indexIdentity: { status: 'valid' } },
};
const health = {
  version: 2,
  agentId,
  providerId: 'memory-core',
  status: 'degraded',
  details: { legacy: detail },
};
const probe = { agentId, provider: 'openai', embedding: { checked: true, ok: true } };
const unavailable = async () => assert.fail('unexpected transport');

function online(request: MemoryStatusDependencies['request']): MemoryStatusDependencies {
  return { readCli: async () => refusal, request };
}

describe('agent/lifecycle/inspect-memory-status', () => {
  it('should retain offline index evidence without gateway access', async () => {
    const result = await inspectMemoryIndex(agentId, {
      readCli: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify([{ agentId, status: detail }]),
      }),
      request: unavailable,
    });
    assert.equal(result.dirty, false);
    assert.equal(result.vector?.index?.state, 'complete');
  });

  it('should retain an offline failed embedding probe despite a nonzero exit', async () => {
    const result = await inspectMemoryEmbedding(agentId, {
      readCli: async () => ({
        code: 1,
        stderr: '',
        stdout: JSON.stringify([
          { agentId, status: detail, embeddingProbe: { ok: false, error: '401' } },
        ]),
      }),
      request: unavailable,
    });
    assert.equal(result.probe?.ok, false);
    assert.equal(result.probe?.error, '401');
  });

  it('should inspect index health without requiring or performing an embedding probe', async () => {
    const result = await inspectMemoryIndex(
      agentId,
      online(async (method, params) => {
        assert.equal(method, 'memory.status');
        assert.deepEqual(params, { agentId });
        return health;
      }),
    );
    assert.equal(result.health, 'degraded');
    assert.deepEqual(result.vector, detail.vector);
    assert.deepEqual(result.custom, detail.custom);
  });

  it('should probe embeddings without requiring or reading index health', async () => {
    const result = await inspectMemoryEmbedding(
      agentId,
      online(async (method, params) => {
        assert.equal(method, 'doctor.memory.status');
        assert.deepEqual(params, { agentId, probe: true });
        return probe;
      }),
    );
    assert.deepEqual(result, { provider: 'openai', probe: probe.embedding });
  });

  it('should preserve provider failure without requiring provider activation', async () => {
    const result = await inspectMemoryEmbedding(
      agentId,
      online(async () => ({
        agentId,
        embedding: { checked: true, ok: false, error: '401 authentication failed' },
      })),
    );
    assert.equal(result.probe?.ok, false);
    assert.match(result.probe?.error ?? '', /401/u);
  });

  it('should reject unrelated cli errors without trying a different authority path', async () => {
    for (const inspect of [inspectMemoryIndex, inspectMemoryEmbedding]) {
      for (const stderr of [
        'permission denied',
        'invalid config',
        'exclusive offline state ownership',
      ]) {
        await assert.rejects(
          inspect(agentId, { readCli: async () => ({ ...refusal, stderr }), request: unavailable }),
        );
      }
    }
  });

  it('should reject cross-agent, wrong-provider and malformed index envelopes', async () => {
    for (const bad of [
      { ...health, agentId: 'other' },
      { ...health, version: 1 },
      { ...health, providerId: 'other' },
      { ...health, details: {} },
      { ...health, status: 'unavailable' },
    ])
      await assert.rejects(
        inspectMemoryIndex(
          agentId,
          online(async () => bad),
        ),
      );
  });

  it('should reject cross-agent or malformed embedding evidence', async () => {
    for (const bad of [
      { ...probe, agentId: 'other' },
      { agentId },
      { agentId, embedding: {} },
      { agentId, embedding: { ok: true } },
    ])
      await assert.rejects(
        inspectMemoryEmbedding(
          agentId,
          online(async () => bad),
        ),
      );
  });

  it('should propagate transport and authorization failures for each check', async () => {
    const error = new Error('gateway denied');
    for (const inspect of [inspectMemoryIndex, inspectMemoryEmbedding]) {
      await assert.rejects(
        inspect(
          agentId,
          online(async () => {
            throw error;
          }),
        ),
        (actual) => actual === error,
      );
    }
  });
});
