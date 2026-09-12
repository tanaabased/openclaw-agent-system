import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createModelLifecycleContribution, {
  type ModelLifecycleDependencies,
} from '../agent/model-lifecycle.ts';
import type { ModelRuntimeStatusSnapshot } from '../agent/model-runtime-status.ts';
import { configuredAgentValue } from '../core/configured-agents.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'emori', name: 'EMORI' },
  models: {
    default: { model: 'openai/gpt-6-astra', effort: 'high' },
    low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
    medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
    high: { model: 'openai/gpt-6-astra', effort: 'xhigh' },
  },
};
const context = { manifest, workspaceDir: '/workspace/emori' };

interface CatalogRow {
  available: boolean | null;
  key: string;
  missing: boolean;
}

const catalogRows: CatalogRow[] = [
  { available: true, key: 'openai/gpt-6-astra', missing: false },
  { available: true, key: 'openai/gpt-5.6-terra', missing: false },
  { available: true, key: 'openai/gpt-5.6-sol', missing: false },
];

interface HarnessOptions {
  catalog?: CatalogRow[];
  nativeAuthReady?: boolean;
  providerAuthReady?: boolean;
  runtimeStatus?: ModelRuntimeStatusSnapshot;
  runtimeStatusError?: boolean;
  supportedEfforts?: string[];
}

function parseRef(value: string) {
  const separator = value.indexOf('/');
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function createHarness(config: OpenClawConfig, options: HarnessOptions = {}) {
  let mutations = 0;
  let providerAuthChecks = 0;
  let runtimeStatusChecks = 0;
  const dependencies: ModelLifecycleDependencies = {
    async inspectModelCatalog() {
      return options.catalog ?? catalogRows;
    },
    async inspectModelRuntimeStatus() {
      runtimeStatusChecks += 1;
      if (options.runtimeStatusError) throw new Error('status unavailable');
      return (
        options.runtimeStatus ?? {
          issues: [],
          routes: [{ provider: 'openai', runtime: 'codex', status: 'usable' }],
        }
      );
    },
    async mutateConfigFile({ mutate }) {
      mutations += 1;
      return { result: mutate(config) as boolean | undefined };
    },
    readConfig: () => config,
    resolveCliBackendDispatchEligibility({ agentId, config: current, model, provider }) {
      if (options.nativeAuthReady === false) return;
      const agent = configuredAgentValue(current, agentId);
      const runtime = agent?.models?.[`${provider}/${model}`]?.agentRuntime?.id ?? 'openclaw';
      return runtime === 'openclaw' ? undefined : { provider: runtime };
    },
    resolveDefaultModelForAgent({ agentId, config: current }) {
      const agent = configuredAgentValue(current, agentId);
      const selected =
        typeof agent?.model === 'string'
          ? agent.model
          : (agent?.model?.primary ?? 'openai/gpt-5.6-sol');
      return parseRef(selected);
    },
    resolveThinkingPolicy() {
      return {
        levels: (options.supportedEfforts ?? ['medium', 'high', 'xhigh']).map((id) => ({ id })),
      };
    },
    async verifyProviderAuth() {
      providerAuthChecks += 1;
      if (options.providerAuthReady === false) throw new Error('missing auth');
      return { mode: 'api-key' };
    },
  };
  return {
    contribution: createModelLifecycleContribution(dependencies),
    mutations: () => mutations,
    providerAuthChecks: () => providerAuthChecks,
    runtimeStatusChecks: () => runtimeStatusChecks,
  };
}

function codexConfig(): OpenClawConfig {
  return {
    agents: {
      entries: {
        emori: {
          model: {
            primary: 'openai/gpt-5.6-sol',
            fallbacks: ['anthropic/claude-sonnet'],
          },
          models: {
            'openai/gpt-5.6-sol': {
              agentRuntime: { id: 'codex' },
              params: { serviceTier: 'default' },
            },
            'openai/gpt-6-astra': { alias: 'astra' },
            'anthropic/claude-sonnet': { alias: 'fallback' },
          },
          thinkingDefault: 'medium',
          workspace: '/workspace/emori',
        },
      },
    },
  };
}

describe('agent/model-lifecycle', () => {
  it('should activate only for manifests that declare models', () => {
    const { contribution } = createHarness(codexConfig());

    assert.equal(contribution.isConfigured(manifest), true);
    assert.equal(contribution.isConfigured({ schemaVersion: 1, agent: { id: 'emori' } }), false);
  });

  it('should report configuration drift without mutating doctor state', async () => {
    const config = codexConfig();
    const before = structuredClone(config);
    const { contribution, mutations } = createHarness(config);

    const findings = await contribution.inspect?.(context);

    assert.equal(
      findings?.some(({ code }) => code === 'agent-model-config-drift'),
      true,
    );
    assert.deepEqual(config, before);
    assert.equal(mutations(), 0);
  });

  it('should preserve the verified native route and unrelated model configuration', async () => {
    const config = codexConfig();
    const { contribution, mutations } = createHarness(config);

    const installed = await contribution.reconcile?.(context);
    const agent = config.agents?.entries?.emori;

    assert.deepEqual(
      installed?.outcomes.map(({ code, status }) => ({ code, status })),
      [{ code: 'set-agent-models', status: 'updated' }],
    );
    assert.deepEqual(agent?.model, {
      primary: 'openai/gpt-6-astra',
      fallbacks: ['anthropic/claude-sonnet'],
    });
    assert.equal(agent?.thinkingDefault, 'high');
    assert.deepEqual(agent?.models?.['openai/gpt-6-astra'], {
      alias: 'astra',
      agentRuntime: { id: 'codex' },
    });
    assert.deepEqual(agent?.models?.['openai/gpt-5.6-terra'], {
      agentRuntime: { id: 'codex' },
    });
    assert.deepEqual(agent?.models?.['openai/gpt-5.6-sol'], {
      agentRuntime: { id: 'codex' },
      params: { serviceTier: 'default' },
    });
    assert.deepEqual(agent?.models?.['anthropic/claude-sonnet'], { alias: 'fallback' });

    const repeated = await contribution.reconcile?.(context);

    assert.equal(repeated?.outcomes[0]?.status, 'unchanged');
    assert.equal(mutations(), 1);
  });

  it('should refuse to overwrite an explicit conflicting runtime', async () => {
    const config = codexConfig();
    config.agents!.entries!.emori!.models!['openai/gpt-6-astra'] = {
      agentRuntime: { id: 'openclaw' },
    };
    const { contribution, mutations } = createHarness(config);

    assert.equal(
      (await contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-conflict',
    );
    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError && error.code === 'agent-model-runtime-conflict',
    );
    assert.equal(mutations(), 0);
  });

  it('should refuse inherited and ambiguous runtime bindings', async () => {
    const inherited = codexConfig();
    inherited.agents!.defaults = {
      models: { 'openai/gpt-5.6-terra': { agentRuntime: { id: 'openclaw' } } },
    };
    const ambiguous = codexConfig();
    ambiguous.agents!.entries!.emori!.models!['openai/gpt-5.6-terra'] = {
      agentRuntime: { id: 'auto' },
    };

    assert.equal(
      (await createHarness(inherited).contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-conflict',
    );
    assert.equal(
      (await createHarness(ambiguous).contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-conflict',
    );
  });

  it('should preserve a usable native api key route without resolving credential material', async () => {
    const config = codexConfig();
    const { contribution, providerAuthChecks } = createHarness(config, {
      nativeAuthReady: false,
    });

    const installed = await contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(providerAuthChecks(), 0);
    assert.equal(
      config.agents?.entries?.emori?.models?.['openai/gpt-6-astra']?.agentRuntime?.id,
      'codex',
    );

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
    assert.equal(providerAuthChecks(), 0);
  });

  it('should accept agent-scoped oauth without cli backend dispatch eligibility', async () => {
    const { contribution, providerAuthChecks, runtimeStatusChecks } = createHarness(codexConfig(), {
      nativeAuthReady: false,
      runtimeStatus: {
        issues: [],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'usable' }],
      },
    });

    await contribution.reconcile?.(context);

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
    assert.equal(providerAuthChecks(), 0);
    assert.equal(runtimeStatusChecks(), 1);
  });

  it('should preserve model-specific route issue semantics', async () => {
    const missing = createHarness(codexConfig(), {
      runtimeStatus: {
        issues: [
          {
            authRequirement: 'subscription',
            kind: 'missing-auth',
            message: 'No usable subscription authentication is available.',
            model: 'gpt-5.6-sol',
            provider: 'openai',
          },
        ],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'usable' }],
      },
    });
    const indeterminate = createHarness(codexConfig(), {
      runtimeStatus: {
        issues: [
          {
            kind: 'indeterminate',
            message: 'Authentication could not be determined.',
            model: 'gpt-5.6-sol',
            provider: 'openai',
          },
        ],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'usable' }],
      },
    });

    assert.equal(
      (await missing.contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-auth-unavailable',
    );
    assert.equal(
      (await indeterminate.contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-evidence-unavailable',
    );
  });

  it('should distinguish missing native authentication from unavailable evidence', async () => {
    const missing = createHarness(codexConfig(), {
      nativeAuthReady: false,
      runtimeStatus: {
        issues: [],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'missing' }],
      },
    });
    const indeterminate = createHarness(codexConfig(), {
      nativeAuthReady: false,
      runtimeStatus: {
        issues: [],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'indeterminate' }],
      },
    });

    assert.equal(
      (await missing.contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-auth-unavailable',
    );
    assert.equal(
      (await indeterminate.contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-evidence-unavailable',
    );
  });

  it('should distinguish unavailable native runtime from usable authentication', async () => {
    const { contribution } = createHarness(codexConfig(), {
      nativeAuthReady: false,
      runtimeStatus: {
        issues: [],
        routes: [
          {
            authStatus: 'usable',
            provider: 'openai',
            runtime: 'codex',
            runtimeDetail: 'Codex plugin payload was not verified.',
            status: 'unavailable',
          },
        ],
      },
    });

    assert.equal(
      (await contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-unavailable',
    );
  });

  it('should report failed native status inspection as unavailable evidence', async () => {
    const { contribution } = createHarness(codexConfig(), {
      nativeAuthReady: false,
      runtimeStatusError: true,
    });

    assert.equal(
      (await contribution.inspect?.(context))?.[0]?.code,
      'agent-model-runtime-evidence-unavailable',
    );
  });

  it('should keep installation independent of ambient authentication readiness', async () => {
    const config = codexConfig();
    const inspection = createHarness(config, {
      nativeAuthReady: false,
      runtimeStatus: {
        issues: [],
        routes: [{ provider: 'openai', runtime: 'codex', status: 'missing' }],
      },
    });

    const findings = await inspection.contribution.inspect?.(context);

    assert.equal(
      findings?.some(({ code }) => code === 'agent-model-runtime-auth-unavailable'),
      true,
    );

    const installation = createHarness(config, {
      nativeAuthReady: false,
      providerAuthReady: false,
      runtimeStatusError: true,
    });
    const installed = await installation.contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(installation.providerAuthChecks(), 0);
    assert.equal(installation.runtimeStatusChecks(), 0);
    assert.equal(installation.mutations(), 1);
  });

  it('should reconcile provider-neutral model references through an established route', async () => {
    const alternativeManifest: AgentManifest = {
      schemaVersion: 1,
      agent: manifest.agent,
      models: {
        default: { model: 'anthropic/claude-sonnet-4-5', effort: 'high' },
      },
    };
    const config: OpenClawConfig = {
      agents: {
        entries: {
          emori: {
            model: 'anthropic/claude-haiku-4-5',
            models: {
              'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'claude-code' } },
            },
            thinkingDefault: 'medium',
          },
        },
      },
    };
    const installation = createHarness(config, {
      nativeAuthReady: false,
      providerAuthReady: false,
    });

    const installed = await installation.contribution.reconcile?.({
      manifest: alternativeManifest,
      workspaceDir: context.workspaceDir,
    });

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(installation.providerAuthChecks(), 0);
    assert.equal(
      config.agents?.entries?.emori?.models?.['anthropic/claude-sonnet-4-5']?.agentRuntime?.id,
      'claude-code',
    );
  });

  it('should distinguish unavailable models from unsupported effort', async () => {
    const unavailable = createHarness(codexConfig(), {
      catalog: catalogRows.filter(({ key }) => key !== 'openai/gpt-5.6-terra'),
    });
    const unsupported = createHarness(codexConfig(), {
      supportedEfforts: ['medium', 'high'],
    });

    assert.equal(
      (await unavailable.contribution.inspect?.(context))?.some(
        ({ code }) => code === 'agent-model-unavailable',
      ),
      true,
    );
    assert.equal(
      (await unsupported.contribution.inspect?.(context))?.some(
        ({ code }) => code === 'agent-model-effort-unsupported',
      ),
      true,
    );
  });

  it('should distinguish degraded capability evidence from model absence', async () => {
    const { contribution } = createHarness(codexConfig(), {
      catalog: catalogRows.map((row) =>
        row.key === 'openai/gpt-5.6-terra' ? { ...row, available: null } : row,
      ),
    });

    assert.equal(
      (await contribution.inspect?.(context))?.some(
        ({ code }) => code === 'agent-model-capability-evidence-unavailable',
      ),
      true,
    );
  });

  it('should verify direct provider authentication without exposing credential material', async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          emori: {
            model: 'openai/gpt-6-astra',
            models: {
              'openai/gpt-6-astra': { agentRuntime: { id: 'openclaw' } },
              'openai/gpt-5.6-terra': { agentRuntime: { id: 'openclaw' } },
              'openai/gpt-5.6-sol': { agentRuntime: { id: 'openclaw' } },
            },
            thinkingDefault: 'high',
          },
        },
      },
    };
    const { contribution, providerAuthChecks } = createHarness(config);

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
    assert.equal(providerAuthChecks() > 0, true);
  });

  it('should perform no cleanup after model declarations are removed', async () => {
    const config = codexConfig();
    const { contribution, mutations } = createHarness(config);
    const withoutModels = {
      manifest: { schemaVersion: 1, agent: manifest.agent } as AgentManifest,
      workspaceDir: context.workspaceDir,
    };

    assert.deepEqual(await contribution.reconcile?.(withoutModels), { outcomes: [] });
    assert.equal(mutations(), 0);
  });
});
