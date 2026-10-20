import assert from 'node:assert/strict';

import { memorySecretProviderAlias, memorySecretId } from '../agent/memory-configuration-plan.ts';
import resolveMemorySecretProviderRequest, {
  parseMemorySecretProviderRequest,
} from '../environment/memory-secret-provider.ts';

describe('environment/memory-secret-provider', () => {
  it('should resolve only requested agent bindings through the protocol', async () => {
    const id = memorySecretId('emori', 'MEMORY_OPENAI_API_KEY');
    const calls: Array<{ agentId: string; binding: string }> = [];
    const request = parseMemorySecretProviderRequest(
      JSON.stringify({ protocolVersion: 1, provider: memorySecretProviderAlias, ids: [id] }),
    );

    const result = await resolveMemorySecretProviderRequest(request, {
      async resolveBinding(agentId, binding) {
        calls.push({ agentId, binding });
        return 'PRIVATE_VALUE';
      },
    });

    assert.deepEqual(calls, [{ agentId: 'emori', binding: 'MEMORY_OPENAI_API_KEY' }]);
    assert.deepEqual(result, {
      protocolVersion: 1,
      values: { [id]: 'PRIVATE_VALUE' },
    });
  });

  it('should fail closed per id without exposing resolver errors', async () => {
    const id = memorySecretId('emori', 'MEMORY_OPENAI_API_KEY');
    const result = await resolveMemorySecretProviderRequest(
      { protocolVersion: 1, provider: memorySecretProviderAlias, ids: [id] },
      {
        async resolveBinding() {
          throw new Error('PRIVATE_VALUE Authorization: Bearer private');
        },
      },
    );

    assert.deepEqual(result, {
      protocolVersion: 1,
      values: {},
      errors: { [id]: { code: 'NOT_FOUND' } },
    });
    assert.equal(JSON.stringify(result).includes('PRIVATE_VALUE'), false);
  });

  it('should reject malformed, duplicate, cross-protocol, and oversized requests', () => {
    const id = memorySecretId('emori', 'MEMORY_OPENAI_API_KEY');
    for (const value of [
      {},
      { protocolVersion: 2, provider: memorySecretProviderAlias, ids: [id] },
      { protocolVersion: 1, provider: 'other', ids: [id] },
      { protocolVersion: 1, provider: memorySecretProviderAlias, ids: [id, id] },
      { protocolVersion: 1, provider: memorySecretProviderAlias, ids: ['../../PRIVATE'] },
      {
        protocolVersion: 1,
        provider: memorySecretProviderAlias,
        ids: Array.from({ length: 33 }, (_, index) => memorySecretId(`agent-${index}`, 'KEY')),
      },
    ]) {
      assert.throws(() => parseMemorySecretProviderRequest(JSON.stringify(value)));
    }
  });
});
