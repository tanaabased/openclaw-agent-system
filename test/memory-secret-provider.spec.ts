import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { memorySecretProviderAlias, memorySecretId } from '../agent/memory-configuration-plan.ts';
import resolveMemorySecretProviderRequest, {
  parseMemorySecretProviderRequest,
} from '../environment/memory-secret-provider.ts';

describe('environment/memory-secret-provider', () => {
  it('should resolve only the memory binding from a valid 9.5 config in a fresh helper process', async function () {
    this.timeout(15_000);
    const root = await mkdtemp(join(tmpdir(), 'agent-system-memory-helper-'));
    const configPath = join(root, 'openclaw.json');
    const id = memorySecretId('emori', 'EMBEDDINGS_API_KEY');
    const otherId = memorySecretId('emori', 'OTHER_KEY');
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          meta: { migrations: { utilityModelSeparation: true } },
          agents: { entries: { emori: { workspace: root } } },
        }),
      );
      await writeFile(
        join(root, 'agent.yaml'),
        [
          'schema-version: 1',
          'agent:',
          '  id: emori',
          'memory:',
          '  search:',
          '    provider: openai',
          '    api-key: EMBEDDINGS_API_KEY',
          'environment:',
          '  set:',
          '    EMBEDDINGS_API_KEY: $OPENAI_API_KEY',
          '    OTHER_KEY: unrelated-synthetic-value',
          '',
        ].join('\n'),
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../environment/memory-secret-provider-entry.ts', import.meta.url)),
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            HOME: root,
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENAI_API_KEY: 'synthetic-memory-credential',
          },
          input: JSON.stringify({
            protocolVersion: 1,
            provider: memorySecretProviderAlias,
            ids: [id, otherId],
          }),
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        protocolVersion: 1,
        values: { [id]: 'synthetic-memory-credential' },
        errors: { [otherId]: { code: 'NOT_FOUND' } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
