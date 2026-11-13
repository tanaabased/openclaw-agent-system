import assert from 'node:assert/strict';

import inspectMemoryStatus from '../agent/lifecycle/inspect-memory-status.ts';

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
  fts: { enabled: true, available: true },
  vector: {
    enabled: true,
    storeAvailable: true,
    semanticAvailable: true,
    index: { state: 'complete' },
  },
};
const health = {
  version: 2,
  agentId,
  providerId: 'memory-core',
  status: 'ready',
  details: { legacy: detail },
};
const probe = { agentId, provider: 'openai', embedding: { ok: true } };

describe('agent/lifecycle/inspect-memory-status', () => {
  it('should retain offline inspection without gateway access', async () => {
    const result = await inspectMemoryStatus(agentId, false, {
      readCli: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify([{ agentId, status: detail }]),
      }),
      request: async () => assert.fail('offline inspection must not access the gateway'),
    });
    assert.equal(result.status.provider, 'openai');
    assert.equal(result.status.fts?.available, true);
  });

  it('should retain structured offline failure evidence despite a nonzero exit', async () => {
    const result = await inspectMemoryStatus(agentId, true, {
      readCli: async () => ({
        code: 1,
        stderr: '',
        stdout: JSON.stringify([
          { agentId, status: detail, embeddingProbe: { ok: false, error: '401' } },
        ]),
      }),
      request: async () => assert.fail('offline evidence must not be replaced'),
    });
    assert.equal(result.embeddingProbe?.ok, false);
  });

  it('should combine an agent-scoped live probe with subsequent detailed index evidence', async () => {
    let probed = false;
    const result = await inspectMemoryStatus(agentId, true, {
      readCli: async () => refusal,
      request: async (method, params) => {
        assert.equal(params.agentId, agentId);
        if (method === 'doctor.memory.status') {
          assert.equal(params.probe, true);
          probed = true;
          return probe;
        }
        assert.equal(probed, true);
        return health;
      },
    });
    assert.equal(result.embeddingProbe?.ok, true);
    assert.deepEqual(result.status.vector, detail.vector);
    assert.deepEqual(result.status.fts, detail.fts);
  });

  it('should not initialize an embedding provider for shallow inspection', async () => {
    const result = await inspectMemoryStatus(agentId, false, {
      readCli: async () => refusal,
      request: async (method) => {
        assert.equal(method, 'memory.status');
        return health;
      },
    });
    assert.equal(result.embeddingProbe, undefined);
  });

  it('should preserve a failed embedding probe rather than promoting index health', async () => {
    const result = await inspectMemoryStatus(agentId, true, {
      readCli: async () => refusal,
      request: async (method) =>
        method === 'memory.status'
          ? health
          : {
              ...probe,
              embedding: { ok: false, checked: true, error: '401 authentication failed' },
            },
    });
    assert.equal(result.embeddingProbe?.ok, false);
    assert.match(result.embeddingProbe?.error ?? '', /401/u);
  });

  it('should reject unrelated cli errors without trying a different authority path', async () => {
    for (const stderr of [
      'permission denied',
      'invalid config',
      'exclusive offline state ownership',
    ]) {
      await assert.rejects(
        inspectMemoryStatus(agentId, true, {
          readCli: async () => ({ ...refusal, stderr }),
          request: async () => assert.fail('unexpected fallback'),
        }),
      );
    }
  });

  it('should reject cross-agent, mismatched, incomplete and degraded online evidence', async () => {
    for (const bad of [
      { ...health, agentId: 'other' },
      { ...health, providerId: 'other' },
      { ...health, details: {} },
      { ...health, status: 'degraded' },
      { ...health, details: { legacy: { ...detail, provider: 'none' } } },
    ]) {
      await assert.rejects(
        inspectMemoryStatus(agentId, true, {
          readCli: async () => refusal,
          request: async (method) => (method === 'memory.status' ? bad : probe),
        }),
      );
    }
    for (const bad of [{ ...probe, agentId: 'other' }, { agentId }, { agentId, embedding: {} }]) {
      await assert.rejects(
        inspectMemoryStatus(agentId, true, {
          readCli: async () => refusal,
          request: async (method) => (method === 'memory.status' ? health : bad),
        }),
      );
    }
  });

  it('should propagate gateway authorization and transport failures', async () => {
    const error = new Error('gateway denied');
    await assert.rejects(
      inspectMemoryStatus(agentId, true, {
        readCli: async () => refusal,
        request: async () => {
          throw error;
        },
      }),
      (actual) => actual === error,
    );
  });
});
