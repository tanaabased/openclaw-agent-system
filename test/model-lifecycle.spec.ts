import assert from 'node:assert/strict';

import { resolveAllowedModelRef as resolveOpenClawAllowedModelRef } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createModelLifecycleContribution, {
  type ModelLifecycleDependencies,
} from '../agent/model-lifecycle.ts';
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

interface ModelListRow {
  available: boolean | null;
  key: string;
  missing: boolean;
}

const configuredModels: ModelListRow[] = [
  { available: true, key: 'openai/gpt-6-astra', missing: false },
  { available: true, key: 'openai/gpt-5.6-terra', missing: false },
  { available: true, key: 'openai/gpt-5.6-sol', missing: false },
];

interface HarnessOptions {
  configuredModels?: ModelListRow[];
  configuredModelsError?: boolean;
  nativeAuthReady?: boolean;
  supportedEfforts?: string[];
}

function parseRef(value: string) {
  const separator = value.indexOf('/');
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function createHarness(config: OpenClawConfig, options: HarnessOptions = {}) {
  let mutations = 0;
  let configuredModelChecks = 0;
  const dependencies: ModelLifecycleDependencies = {
    async inspectConfiguredModels() {
      configuredModelChecks += 1;
      if (options.configuredModelsError) throw new Error('model list unavailable');
      return options.configuredModels ?? configuredModels;
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
    resolveAllowedModelRef({ agentId, config: current, defaultProvider, raw }) {
      return resolveOpenClawAllowedModelRef({
        agentId,
        catalog: [],
        cfg: current,
        defaultProvider,
        raw,
      });
    },
    resolveThinkingPolicy() {
      return {
        levels: (options.supportedEfforts ?? ['medium', 'high', 'xhigh']).map((id) => ({ id })),
      };
    },
  };
  return {
    configuredModelChecks: () => configuredModelChecks,
    contribution: createModelLifecycleContribution(dependencies),
    mutations: () => mutations,
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

function readyCodexConfig(): OpenClawConfig {
  const config = codexConfig();
  const agent = config.agents!.entries!.emori!;
  agent.model = {
    primary: 'openai/gpt-6-astra',
    fallbacks: ['anthropic/claude-sonnet'],
  };
  agent.thinkingDefault = 'high';
  agent.models!['openai/gpt-6-astra'] = {
    alias: 'astra',
    agentRuntime: { id: 'codex' },
  };
  agent.models!['openai/gpt-5.6-terra'] = { agentRuntime: { id: 'codex' } };
  return config;
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

  it('should diagnose and repair inherited selection policy at agent scope', async () => {
    const config = readyCodexConfig();
    config.agents!.defaults = {
      modelPolicy: {
        allow: ['openai/gpt-5.5', 'openai/gpt-5.6-sol', 'openai/gpt-6-astra'],
      },
    };
    config.agents!.entries!.leia = {
      modelPolicy: { allow: ['anthropic/claude-sonnet'] },
    };
    const before = structuredClone(config);
    const { contribution, mutations } = createHarness(config);

    const findings = await contribution.inspect?.(context);

    assert.deepEqual(
      findings
        ?.filter(({ code }) => code === 'agent-model-selection-policy-drift')
        .map(({ message }) => message),
      [
        'OpenClaw model policy agents.defaults.modelPolicy.allow does not allow openai/gpt-5.6-terra for emori.',
      ],
    );
    assert.deepEqual(config, before);
    assert.equal(mutations(), 0);

    const installed = await contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.status, 'updated');
    assert.deepEqual(config.agents?.defaults?.modelPolicy?.allow, [
      'openai/gpt-5.5',
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
    ]);
    assert.deepEqual(config.agents?.entries?.emori?.modelPolicy?.allow, [
      'openai/gpt-5.5',
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-terra',
    ]);
    assert.deepEqual(config.agents?.entries?.leia, before.agents?.entries?.leia);
    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
    assert.equal((await contribution.reconcile?.(context))?.outcomes[0]?.status, 'unchanged');
    assert.equal(mutations(), 1);
  });

  it('should extend an explicit agent selection policy without inheriting defaults', async () => {
    const config = readyCodexConfig();
    config.agents!.defaults = {
      modelPolicy: { allow: ['openai/gpt-5.5', 'openai/gpt-5.6-terra'] },
    };
    config.agents!.entries!.emori!.modelPolicy = {
      allow: ['openai/gpt-5.6-sol', 'openai/gpt-6-astra'],
    };
    const { contribution } = createHarness(config);

    const findings = await contribution.inspect?.(context);

    assert.equal(
      findings?.find(({ code }) => code === 'agent-model-selection-policy-drift')?.message,
      'OpenClaw model policy agents.entries.emori.modelPolicy.allow does not allow openai/gpt-5.6-terra for emori.',
    );

    await contribution.reconcile?.(context);

    assert.deepEqual(config.agents?.entries?.emori?.modelPolicy?.allow, [
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-terra',
    ]);
    assert.deepEqual(config.agents?.defaults?.modelPolicy?.allow, [
      'openai/gpt-5.5',
      'openai/gpt-5.6-terra',
    ]);
  });

  it('should preserve inherited alias permissions when materializing agent policy', async () => {
    const config = readyCodexConfig();
    config.agents!.defaults = {
      models: { 'openai/gpt-5.5': { alias: 'shared' } },
      modelPolicy: { allow: ['shared'] },
    };
    config.agents!.entries!.emori!.models!['anthropic/claude-sonnet'] = {
      alias: 'shared',
    };
    const { contribution } = createHarness(config);

    await contribution.reconcile?.(context);

    assert.deepEqual(config.agents?.entries?.emori?.modelPolicy?.allow, [
      'openai/gpt-5.5',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-sol',
    ]);
    assert.deepEqual(config.agents?.defaults?.modelPolicy?.allow, ['shared']);
  });

  it('should leave unrestricted and wildcard selection policies unchanged', async () => {
    const unrestricted = readyCodexConfig();
    const wildcard = readyCodexConfig();
    wildcard.agents!.defaults = { modelPolicy: { allow: ['openai/*'] } };
    const unrestrictedHarness = createHarness(unrestricted);
    const wildcardHarness = createHarness(wildcard);

    assert.equal(
      (await unrestrictedHarness.contribution.inspect?.(context))?.[0]?.code,
      'agent-models-ready',
    );
    assert.equal(
      (await wildcardHarness.contribution.inspect?.(context))?.[0]?.code,
      'agent-models-ready',
    );
    assert.equal(
      (await unrestrictedHarness.contribution.reconcile?.(context))?.outcomes[0]?.status,
      'unchanged',
    );
    assert.equal(
      (await wildcardHarness.contribution.reconcile?.(context))?.outcomes[0]?.status,
      'unchanged',
    );
    assert.equal(unrestrictedHarness.mutations(), 0);
    assert.equal(wildcardHarness.mutations(), 0);
    assert.equal(unrestricted.agents?.entries?.emori?.modelPolicy, undefined);
    assert.equal(wildcard.agents?.entries?.emori?.modelPolicy, undefined);
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

  it('should preserve a native route without inspecting authentication', async () => {
    const config = codexConfig();
    const { configuredModelChecks, contribution } = createHarness(config, {
      nativeAuthReady: false,
    });

    const installed = await contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(configuredModelChecks(), 0);
    assert.equal(
      config.agents?.entries?.emori?.models?.['openai/gpt-6-astra']?.agentRuntime?.id,
      'codex',
    );

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
    assert.equal(configuredModelChecks(), 1);
  });

  it('should keep installation independent of configured model inspection', async () => {
    const config = codexConfig();
    const { configuredModelChecks, contribution, mutations } = createHarness(config, {
      configuredModelsError: true,
      nativeAuthReady: false,
    });

    const installed = await contribution.reconcile?.(context);

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(configuredModelChecks(), 0);
    assert.equal(mutations(), 1);
    assert.equal(
      (await contribution.inspect?.(context))?.[0]?.code,
      'agent-model-catalog-evidence-unavailable',
    );
    assert.equal(configuredModelChecks(), 1);
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
    const installation = createHarness(config, { nativeAuthReady: false });

    const installed = await installation.contribution.reconcile?.({
      manifest: alternativeManifest,
      workspaceDir: context.workspaceDir,
    });

    assert.equal(installed?.outcomes[0]?.code, 'set-agent-models');
    assert.equal(
      config.agents?.entries?.emori?.models?.['anthropic/claude-sonnet-4-5']?.agentRuntime?.id,
      'claude-code',
    );
  });

  it('should distinguish missing configured models from unsupported effort', async () => {
    const missing = createHarness(codexConfig(), {
      configuredModels: configuredModels.filter(({ key }) => key !== 'openai/gpt-5.6-terra'),
    });
    const unsupported = createHarness(codexConfig(), {
      supportedEfforts: ['medium', 'high'],
    });

    assert.equal(
      (await missing.contribution.inspect?.(context))?.some(
        ({ code }) => code === 'agent-model-missing',
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

  it('should warn about explicit model unavailability without blocking unknown availability', async () => {
    const unavailable = createHarness(codexConfig(), {
      configuredModels: configuredModels.map((row) =>
        row.key === 'openai/gpt-5.6-terra' ? { ...row, available: false } : row,
      ),
    });
    const unknown = createHarness(codexConfig(), {
      configuredModels: configuredModels.map((row) =>
        row.key === 'openai/gpt-5.6-terra' ? { ...row, available: null } : row,
      ),
    });

    await unavailable.contribution.reconcile?.(context);
    await unknown.contribution.reconcile?.(context);
    const unavailableFindings = await unavailable.contribution.inspect?.(context);
    const unknownFindings = await unknown.contribution.inspect?.(context);

    assert.equal(
      unavailableFindings?.some(
        ({ code, status }) => code === 'agent-model-unavailable' && status === 'warning',
      ),
      true,
    );
    assert.equal(
      unavailableFindings?.some(({ status }) => status === 'blocked'),
      false,
    );
    assert.equal(unknownFindings?.[0]?.code, 'agent-models-ready');
  });

  it('should accept direct OPENCLAW runtime configuration without inspecting authentication', async () => {
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
    const { contribution } = createHarness(config);

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-models-ready');
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

  it('should preserve model policy entries after a profile is removed', async () => {
    const config = readyCodexConfig();
    config.agents!.entries!.emori!.modelPolicy = {
      allow: ['openai/gpt-5.6-sol', 'openai/gpt-6-astra', 'openai/gpt-5.6-terra'],
    };
    const defaultOnlyManifest: AgentManifest = {
      schemaVersion: 1,
      agent: manifest.agent,
      models: { default: manifest.models!.default },
    };
    const { contribution, mutations } = createHarness(config);

    const outcome = await contribution.reconcile?.({
      manifest: defaultOnlyManifest,
      workspaceDir: context.workspaceDir,
    });

    assert.equal(outcome?.outcomes[0]?.status, 'unchanged');
    assert.deepEqual(config.agents?.entries?.emori?.modelPolicy?.allow, [
      'openai/gpt-5.6-sol',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-terra',
    ]);
    assert.equal(mutations(), 0);
  });
});
