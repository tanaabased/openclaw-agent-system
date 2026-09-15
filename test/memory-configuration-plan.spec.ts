import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createMemoryConfigurationPlan, {
  memorySecretId,
  memorySecretProviderAlias,
} from '../agent/memory-configuration-plan.ts';
import type { MemorySecretProviderConfiguration } from '../agent/memory-secret-provider-configuration.ts';

function standaloneProvider(
  packageDir = '/checkout/agent-system',
): MemorySecretProviderConfiguration {
  return {
    source: 'exec',
    command: '/runtime/node',
    args: [`${packageDir}/dist/memory-secret-provider-entry.js`],
    timeoutMs: 90_000,
    noOutputTimeoutMs: 90_000,
    maxOutputBytes: 1024 * 1024,
    jsonOnly: true,
    passEnv: [
      'DBUS_SESSION_BUS_ADDRESS',
      'HOME',
      'OPENAI_API_KEY',
      'OPENCLAW_CONFIG_PATH',
      'OPENCLAW_STATE_DIR',
      'XDG_CONFIG_HOME',
      'XDG_RUNTIME_DIR',
    ],
    trustedDirs: ['/runtime', packageDir],
  };
}

function config(): OpenClawConfig {
  return {
    agents: {
      entries: {
        emori: {
          memory: {
            search: {
              sources: ['memory', 'sessions'],
              remote: { batch: { enabled: false } },
            },
          },
          workspace: '/workspace/emori',
        },
        leia: {
          memory: { search: { provider: 'local' } },
          workspace: '/workspace/leia',
        },
      },
    },
    secrets: {
      providers: { existing: { source: 'store' } },
    },
  };
}

describe('agent/memory-configuration-plan', () => {
  it('should configure one agent and a managed secret provider without mutating input', () => {
    const source = config();
    const before = structuredClone(source);
    const plan = createMemoryConfigurationPlan(source, 'emori', {
      search: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'EMBEDDINGS_API_KEY',
      },
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, true);
    assert.deepEqual(source, before);
    assert.deepEqual(plan.config.agents?.entries?.emori?.memory?.search, {
      provider: 'openai',
      fallback: 'none',
      model: 'text-embedding-3-small',
      sources: ['memory', 'sessions'],
      remote: {
        apiKey: {
          source: 'exec',
          provider: memorySecretProviderAlias,
          id: memorySecretId('emori', 'EMBEDDINGS_API_KEY'),
        },
        batch: { enabled: false },
      },
    });
    assert.deepEqual(plan.config.secrets?.providers?.[memorySecretProviderAlias], {
      source: 'exec',
      pluginIntegration: { pluginId: 'agent-system', integrationId: 'environment' },
    });
    assert.deepEqual(plan.config.secrets?.providers?.existing, { source: 'store' });
    assert.deepEqual(plan.config.agents?.entries?.leia, source.agents?.entries?.leia);
  });

  it('should remove stale owned model and key fields when selecting keyword search', () => {
    const source = config();
    source.agents!.entries!.emori!.memory!.search = {
      provider: 'openai',
      fallback: 'local',
      model: 'text-embedding-3-small',
      remote: {
        apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' },
        batch: { enabled: false },
      },
      sources: ['sessions'],
    };
    source.secrets!.providers![memorySecretProviderAlias] = standaloneProvider();

    const plan = createMemoryConfigurationPlan(source, 'emori', {
      search: { provider: 'none' },
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.deepEqual(plan.config.agents?.entries?.emori?.memory?.search, {
      provider: 'none',
      fallback: 'none',
      remote: { batch: { enabled: false } },
      sources: ['sessions'],
    });
    assert.deepEqual(
      plan.config.secrets?.providers?.[memorySecretProviderAlias],
      standaloneProvider(),
    );
  });

  it('should migrate between linked and managed provider forms idempotently', () => {
    const linked = standaloneProvider();
    const first = createMemoryConfigurationPlan(
      config(),
      'emori',
      { search: { provider: 'openai', apiKey: 'OPENAI_API_KEY' } },
      linked,
    );
    assert.equal(first.status, 'ready');
    if (first.status !== 'ready') return;
    assert.deepEqual(first.config.secrets?.providers?.[memorySecretProviderAlias], linked);
    assert.equal(first.providerChanged, true);

    const repeated = createMemoryConfigurationPlan(
      first.config,
      'emori',
      { search: { provider: 'openai', apiKey: 'OPENAI_API_KEY' } },
      linked,
    );
    assert.equal(repeated.status, 'ready');
    if (repeated.status !== 'ready') return;
    assert.equal(repeated.changed, false);

    const managed = createMemoryConfigurationPlan(
      repeated.config,
      'emori',
      { search: { provider: 'openai', apiKey: 'OPENAI_API_KEY' } },
      {
        source: 'exec',
        pluginIntegration: { pluginId: 'agent-system', integrationId: 'environment' },
      },
    );
    assert.equal(managed.status, 'ready');
    if (managed.status !== 'ready') return;
    assert.deepEqual(managed.config.secrets?.providers?.[memorySecretProviderAlias], {
      source: 'exec',
      pluginIntegration: { pluginId: 'agent-system', integrationId: 'environment' },
    });
  });

  it('should report unchanged after the planned configuration is applied', () => {
    const first = createMemoryConfigurationPlan(config(), 'emori', {
      search: { provider: 'local' },
    });
    assert.equal(first.status, 'ready');
    if (first.status !== 'ready') return;

    const repeated = createMemoryConfigurationPlan(first.config, 'emori', {
      search: { provider: 'local' },
    });

    assert.equal(repeated.status, 'ready');
    if (repeated.status !== 'ready') return;
    assert.equal(repeated.changed, false);
  });

  it('should block a conflicting shared provider and a missing agent', () => {
    const conflict = config();
    conflict.secrets!.providers![memorySecretProviderAlias] = {
      source: 'store',
    };
    const alteredStandalone = config();
    const alteredProvider = standaloneProvider();
    if ('command' in alteredProvider) alteredProvider.timeoutMs = 1;
    alteredStandalone.secrets!.providers![memorySecretProviderAlias] = alteredProvider;

    assert.equal(
      createMemoryConfigurationPlan(conflict, 'emori', {
        search: { provider: 'openai', apiKey: 'OPENAI_API_KEY' },
      }).status,
      'conflict',
    );
    assert.equal(
      createMemoryConfigurationPlan(alteredStandalone, 'emori', {
        search: { provider: 'openai', apiKey: 'OPENAI_API_KEY' },
      }).status,
      'conflict',
    );
    assert.equal(
      createMemoryConfigurationPlan(config(), 'missing', {
        search: { provider: 'none' },
      }).status,
      'missing-agent',
    );
  });
});
