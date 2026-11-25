import assert from 'node:assert/strict';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  initializeOpenClawStorage,
  openClawStorageLifecycle,
} from '../agent/storage/openclaw-storage.ts';

const backend = { type: 'sqlite' } as const;
const context = {
  manifest: { schemaVersion: 1 as const, agent: { id: 'agent' } },
  workspaceDir: '/unused',
};

function settings(initial: OpenClawConfig = {}) {
  let saved = structuredClone(initial);
  return {
    readConfig: async () => structuredClone(saved),
    async mutateConfigFile({ mutate }: { mutate(config: OpenClawConfig): boolean }) {
      const draft = structuredClone(saved);
      const result = mutate(draft);
      if (result) saved = draft;
      return { result, nextConfig: structuredClone(saved) };
    },
    readRuntimeConfig: () => structuredClone(saved),
  };
}

describe('openclaw storage configuration', () => {
  it('inspects the sqlite defaults without writing and seeds only an unset global setting', async () => {
    const source = settings({
      plugins: { entries: { 'agent-system': { config: { cleanup: { graceMinutes: 20 } } } } },
    });
    const original = await source.readConfig();
    const lifecycle = openClawStorageLifecycle(source);
    assert.deepEqual(
      (await lifecycle.inspect!(context)).map(({ status }) => status),
      ['healthy', 'healthy'],
    );
    assert.deepEqual(await source.readConfig(), original);
    await Promise.all([
      initializeOpenClawStorage(source, backend),
      initializeOpenClawStorage(source, backend),
    ]);
    const saved = await source.readConfig();
    assert.deepEqual(saved.plugins?.entries?.['agent-system']?.config, {
      cleanup: { graceMinutes: 20 },
      storage: { backend },
    });
    assert.deepEqual(await lifecycle.reconcile!(context), { outcomes: [] });
    assert.deepEqual(await source.readConfig(), saved);
  });

  it('preserves an operator value and projects only the compatible native families', async () => {
    const source = settings({
      plugins: { entries: { 'agent-system': { config: { storage: { backend: 'sqlite' } } } } },
      database: { engine: 'sqlite', families: { workboard: { engine: 'sqlite' } } },
    });
    await initializeOpenClawStorage(source, backend);
    const lifecycle = openClawStorageLifecycle(source);
    assert.equal(
      (await lifecycle.reconcile!(context)).outcomes[0]?.code,
      'openclaw-storage-projected',
    );
    const saved = await source.readConfig();
    assert.deepEqual(saved.plugins?.entries?.['agent-system']?.config?.storage, {
      backend: 'sqlite',
    });
    assert.deepEqual(saved.database?.families, {
      state: { engine: 'sqlite' },
      agent: { engine: 'sqlite' },
      workboard: { engine: 'sqlite' },
    });
    assert.deepEqual(await lifecycle.reconcile!(context), { outcomes: [] });
  });

  it('reports configured and running drift and preserves the gateway settings', async () => {
    const source = settings({
      database: { engine: 'sqlite', families: { state: { engine: 'postgres' } } },
    });
    const before = await source.readConfig();
    const lifecycle = openClawStorageLifecycle({
      ...source,
      readRuntimeConfig: () => ({ database: { families: { agent: { engine: 'postgres' } } } }),
    });
    const findings = await lifecycle.inspect!(context);
    assert.deepEqual(
      findings.map(({ code }) => code),
      ['openclaw-storage-state-drift', 'openclaw-storage-agent-drift'],
    );
    assert.match(findings[1]!.message, /enabled built-in memory/u);
    assert.equal(
      (await lifecycle.reconcile!(context)).warnings?.[0]?.code,
      'openclaw-storage-port-required',
    );
    assert.deepEqual(await source.readConfig(), before);
  });
});
