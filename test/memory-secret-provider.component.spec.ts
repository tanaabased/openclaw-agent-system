import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { memorySecretProviderAlias, memorySecretId } from '../agent/memory-configuration-plan.ts';

describe('environment/memory-secret-provider built helper', () => {
  it('should resolve only the memory binding from a valid 9.5 config in a fresh built helper process', async function () {
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
        [fileURLToPath(new URL('../dist/memory-secret-provider-entry.js', import.meta.url))],
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
});
