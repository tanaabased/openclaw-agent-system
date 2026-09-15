import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createMemoryLifecycleContribution, {
  type MemoryLifecycleDependencies,
} from '../agent/memory-lifecycle.ts';
import { memorySecretProviderAlias } from '../agent/memory-configuration-plan.ts';
import type { MemoryStatus } from '../agent/memory-status.ts';
import type { AgentManifest } from '../manifest/types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'emori', name: 'EMORI' },
  environment: { set: { MEMORY_OPENAI_API_KEY: '$OPENAI_API_KEY' } },
  memory: {
    search: {
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'MEMORY_OPENAI_API_KEY',
    },
  },
};
const context = { manifest, workspaceDir: '/workspace/emori' };

function baseConfig(): OpenClawConfig {
  return {
    agents: {
      entries: {
        emori: { workspace: '/workspace/emori' },
        leia: { workspace: '/workspace/leia' },
      },
    },
  };
}

function readyStatus(provider = 'openai'): MemoryStatus {
  return {
    embeddingProbe: { checked: true, ok: true },
    status: {
      provider,
      requestedProvider: provider,
      fts: { enabled: true, available: true },
      vector: {
        enabled: provider !== 'none',
        index: { state: 'complete' },
        semanticAvailable: provider !== 'none',
        storeAvailable: provider !== 'none',
      },
    },
  };
}

interface HarnessOptions {
  binding?: 'available' | 'missing' | 'unavailable';
  configuredSecret?: 'available' | 'unavailable';
  providerError?: boolean;
  status?: Error | MemoryStatus;
}

function createHarness(config: OpenClawConfig, options: HarnessOptions = {}) {
  let mutations = 0;
  const statusCalls: boolean[] = [];
  const dependencies: MemoryLifecycleDependencies = {
    async inspectMemoryStatus({ deep }) {
      statusCalls.push(deep);
      if (options.status instanceof Error) throw options.status;
      return options.status ?? readyStatus();
    },
    async inspectBinding() {
      return options.binding ?? 'available';
    },
    async inspectConfiguredSecret() {
      return options.configuredSecret ?? 'available';
    },
    async mutateConfigFile({ mutate }) {
      mutations += 1;
      return { result: mutate(config) as boolean | undefined };
    },
    readConfig: () => config,
    resolveSecretProviderConfiguration() {
      if (options.providerError) throw new Error('unavailable');
      return {
        source: 'exec',
        pluginIntegration: { pluginId: 'agent-system', integrationId: 'environment' },
      };
    },
  };
  return {
    contribution: createMemoryLifecycleContribution(dependencies),
    mutations: () => mutations,
    statusCalls,
  };
}

async function installReady(options: HarnessOptions = {}) {
  const config = baseConfig();
  const harness = createHarness(config, options);
  await harness.contribution.reconcile?.(context);
  return { config, ...harness };
}

describe('agent/memory-lifecycle', () => {
  it('should activate only for manifests that declare memory', () => {
    const { contribution } = createHarness(baseConfig());

    assert.equal(contribution.isConfigured(manifest), true);
    assert.equal(contribution.isConfigured({ schemaVersion: 1, agent: { id: 'emori' } }), false);
  });

  it('should report drift before resolving credentials or probing providers', async () => {
    const { contribution, statusCalls } = createHarness(baseConfig());

    const findings = await contribution.inspect?.(context);

    assert.equal(findings?.[0]?.code, 'agent-memory-config-drift');
    assert.deepEqual(statusCalls, []);
  });

  it('should reconcile once and preserve other agents and providers', async () => {
    const config = baseConfig();
    config.secrets = { providers: { existing: { source: 'store' } } };
    const beforeLeia = structuredClone(config.agents?.entries?.leia);
    const { contribution, mutations } = createHarness(config);

    const installed = await contribution.reconcile?.(context);
    const repeated = await contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-memory');
    assert.equal(repeated?.outcomes[0]?.status, 'unchanged');
    assert.equal(mutations(), 1);
    assert.deepEqual(config.agents?.entries?.leia, beforeLeia);
    assert.deepEqual(config.secrets?.providers?.existing, { source: 'store' });
    assert.equal(config.secrets?.providers?.[memorySecretProviderAlias]?.source, 'exec');
  });

  it('should deeply probe openai and report billing without upstream prose', async () => {
    const { contribution, statusCalls } = await installReady({
      status: {
        ...readyStatus(),
        embeddingProbe: {
          checked: true,
          ok: false,
          error: 'PRIVATE_KEY billing_hard_limit_reached Authorization: Bearer private',
        },
      },
    });

    const findings = await contribution.inspect?.(context);

    assert.deepEqual(statusCalls, [true]);
    assert.equal(findings?.[0]?.code, 'agent-memory-openai-billing-or-quota');
    assert.equal(JSON.stringify(findings).includes('PRIVATE_KEY'), false);
    assert.equal(JSON.stringify(findings).includes('Authorization'), false);
  });

  it('should block an unavailable declared environment binding before probing', async () => {
    const { contribution, statusCalls } = await installReady({ binding: 'missing' });

    const findings = await contribution.inspect?.(context);

    assert.equal(findings?.[0]?.code, 'agent-memory-credential-missing');
    assert.deepEqual(statusCalls, []);
  });

  it('should reject an unresolved configured secret before accepting an embedding probe', async () => {
    const { contribution, statusCalls } = await installReady({
      configuredSecret: 'unavailable',
      status: readyStatus(),
    });

    const findings = await contribution.inspect?.(context);

    assert.equal(findings?.[0]?.code, 'agent-memory-credential-unresolved');
    assert.deepEqual(statusCalls, []);
  });

  it('should report an unavailable linked provider before configuration drift', async () => {
    const { contribution, statusCalls } = createHarness(baseConfig(), { providerError: true });

    const findings = await contribution.inspect?.(context);

    assert.equal(findings?.[0]?.code, 'agent-memory-secret-provider-unavailable');
    assert.deepEqual(statusCalls, []);
  });

  it('should report local setup guidance without starting a deep probe', async () => {
    const localManifest: AgentManifest = {
      schemaVersion: 1,
      agent: manifest.agent,
      memory: { search: { provider: 'local' } },
    };
    const localContext = { manifest: localManifest, workspaceDir: context.workspaceDir };
    const config = baseConfig();
    const harness = createHarness(config, { status: new Error('provider setup required') });
    await harness.contribution.reconcile?.(localContext);

    const findings = await harness.contribution.inspect?.(localContext);

    assert.deepEqual(harness.statusCalls, [false]);
    assert.equal(findings?.[0]?.code, 'agent-memory-provider-unavailable');
    assert.equal(findings?.[0]?.remediation?.includes('--provider llama-cpp --method local'), true);
    assert.equal(findings?.[0]?.remediation?.includes('plugins install'), false);
  });

  it('should distinguish keyword readiness and incompatible indexes', async () => {
    const noneManifest: AgentManifest = {
      schemaVersion: 1,
      agent: manifest.agent,
      memory: { search: { provider: 'none' } },
    };
    const noneContext = { manifest: noneManifest, workspaceDir: context.workspaceDir };
    const noneConfig = baseConfig();
    const none = createHarness(noneConfig, { status: readyStatus('none') });
    await none.contribution.reconcile?.(noneContext);
    assert.equal(
      (await none.contribution.inspect?.(noneContext))?.[0]?.code,
      'agent-memory-keyword-ready',
    );

    const empty = await installReady({
      status: {
        ...readyStatus(),
        status: {
          ...readyStatus().status,
          files: 0,
          chunks: 0,
          vector: { ...readyStatus().status.vector!, index: { state: 'empty' } },
          custom: { indexIdentity: { status: 'missing' } },
        },
      },
    });
    assert.equal(
      (await empty.contribution.inspect?.(context))?.[0]?.code,
      'agent-memory-openai-ready',
    );

    const incompatible = await installReady({
      status: {
        ...readyStatus(),
        status: {
          ...readyStatus().status,
          custom: {
            indexIdentity: { status: 'mismatched', owner: 'configuration', code: 'model' },
          },
        },
      },
    });
    assert.equal(
      (await incompatible.contribution.inspect?.(context))?.[0]?.code,
      'agent-memory-index-incomplete',
    );
  });

  it('should perform no cleanup after the memory declaration is removed', async () => {
    const { contribution, mutations } = createHarness(baseConfig());
    const withoutMemory = {
      manifest: { schemaVersion: 1, agent: manifest.agent } as AgentManifest,
      workspaceDir: context.workspaceDir,
    };

    assert.deepEqual(await contribution.reconcile?.(withoutMemory), { outcomes: [] });
    assert.equal(mutations(), 0);
  });
});
