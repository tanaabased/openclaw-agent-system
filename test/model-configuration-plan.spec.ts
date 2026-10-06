import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import createConfigurationPlan, {
  type ModelConfigurationDependencies,
} from '../agent/model-configuration-plan.ts';

const dependencies: ModelConfigurationDependencies = {
  resolveCliBackendDispatchEligibility: () => ({ provider: 'codex' }),
  resolveDefaultModelForAgent: () => ({ provider: 'openai', model: 'previous' }),
  resolveAllowedModelRef({ config, agentId, raw }) {
    const allow = config.agents?.entries?.[agentId ?? '']?.modelPolicy?.allow ?? [];
    return allow.includes(raw)
      ? { key: raw, ref: { provider: 'openai', model: raw.slice('openai/'.length) } }
      : { error: 'not allowed' };
  },
};
const models = { default: { model: 'openai/next', effort: 'high' as const } };

function configWithModel(
  model?: string | { primary: string; fallbacks?: string[]; alias?: string },
): OpenClawConfig {
  return {
    agents: {
      entries: {
        emori: {
          ...(model === undefined ? {} : { model }),
          modelPolicy: { allow: ['openai/next'] },
          models: { 'openai/next': { agentRuntime: { id: 'codex' } } },
          thinkingDefault: 'high',
        },
      },
    },
  };
}

describe('agent/model-configuration-plan', () => {
  it('should bind every distinct profile to the declared runtime without consulting old routes', () => {
    const profiles = {
      default: { model: 'openai/next', effort: 'high' as const },
      low: { model: 'openai/small', effort: 'medium' as const },
      medium: { model: 'openai/next', effort: 'high' as const },
      high: { model: 'openai/large', effort: 'xhigh' as const },
    };
    const unexpected = () => {
      throw new Error('declared runtime must not depend on an existing route');
    };
    const declaredDependencies = {
      ...dependencies,
      resolveCliBackendDispatchEligibility: unexpected,
      resolveDefaultModelForAgent: unexpected,
    };
    const configs: OpenClawConfig[] = [
      { agents: { entries: { emori: {} } } },
      {
        agents: {
          defaults: { thinkingDefault: 'medium' },
          entries: {
            emori: {
              model: { primary: 'openai/previous', fallbacks: ['anthropic/fallback'] },
              models: {
                'openai/previous': { agentRuntime: { id: 'openclaw' } },
                'openai/next': { alias: 'next', params: { serviceTier: 'default' } },
              },
              modelPolicy: { allow: ['openai/previous'] },
            },
            leia: { model: 'openai/previous' },
          },
        },
      },
    ];

    for (const config of configs) {
      const before = structuredClone(config);
      const plan = createConfigurationPlan(
        config,
        'emori',
        profiles,
        declaredDependencies,
        'codex',
      );
      assert.equal(plan.status, 'ready');
      if (plan.status !== 'ready') continue;
      assert.equal(plan.sourceRuntime, 'codex');
      assert.equal(plan.changed, true);
      const agent = plan.config.agents?.entries?.emori;
      assert.deepEqual(agent?.model, {
        primary: 'openai/next',
        fallbacks: before.agents?.entries?.emori?.model ? ['anthropic/fallback'] : [],
      });
      assert.equal(agent?.thinkingDefault, 'high');
      for (const value of ['openai/next', 'openai/small', 'openai/large']) {
        assert.equal(agent?.models?.[value]?.agentRuntime?.id, 'codex');
        assert.equal(agent?.modelPolicy?.allow?.includes(value), true);
      }
      assert.deepEqual(
        agent?.models?.['openai/previous'],
        before.agents?.entries?.emori?.models?.['openai/previous'],
      );
      assert.equal(
        agent?.models?.['openai/next']?.alias,
        before.agents?.entries?.emori?.models?.['openai/next']?.alias,
      );
      assert.deepEqual(
        agent?.models?.['openai/next']?.params,
        before.agents?.entries?.emori?.models?.['openai/next']?.params,
      );
      assert.deepEqual(plan.config.agents?.defaults, before.agents?.defaults);
      assert.deepEqual(plan.config.agents?.entries?.leia, before.agents?.entries?.leia);
      assert.deepEqual(config, before);

      const repeated = createConfigurationPlan(
        plan.config,
        'emori',
        profiles,
        declaredDependencies,
        'codex',
      );
      assert.equal(repeated.status, 'ready');
      if (repeated.status === 'ready') {
        assert.equal(repeated.changed, false);
        assert.deepEqual(repeated.config, plan.config);
      }
    }
  });

  it('should retain default route inference when runtime is omitted', () => {
    const config: OpenClawConfig = { agents: { entries: { emori: {} } } };
    const plan = createConfigurationPlan(config, 'emori', models, {
      ...dependencies,
      resolveCliBackendDispatchEligibility: () => undefined,
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.sourceRuntime, 'openclaw');
    assert.equal(
      plan.config.agents?.entries?.emori?.models?.['openai/next']?.agentRuntime?.id,
      'openclaw',
    );
  });

  it('should reject explicit and inherited conflicts with the declared runtime without changing state', () => {
    const configs: OpenClawConfig[] = [
      {
        agents: {
          entries: { emori: { models: { 'openai/next': { agentRuntime: { id: 'openclaw' } } } } },
        },
      },
      {
        agents: {
          defaults: { models: { 'openai/next': { agentRuntime: { id: 'openclaw' } } } },
          entries: { emori: {} },
        },
      },
      {
        agents: {
          entries: { emori: { models: { 'openai/*': { agentRuntime: { id: 'openclaw' } } } } },
        },
      },
      {
        agents: {
          entries: { emori: { models: { 'openai/next': { agentRuntime: { id: 'auto' } } } } },
        },
      },
      {
        agents: { entries: { emori: {} } },
        models: {
          providers: {
            openai: {
              baseUrl: 'https://example.invalid',
              agentRuntime: { id: 'openclaw' },
              models: [],
            },
          },
        },
      },
    ];

    for (const config of configs) {
      const before = structuredClone(config);
      const plan = createConfigurationPlan(config, 'emori', models, dependencies, 'codex');
      assert.equal(plan.status, 'conflict');
      assert.deepEqual(config, before);
    }
  });

  it('should return a detached agent-only plan without changing the input snapshot', () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          emori: {
            model: 'openai/previous',
            modelPolicy: { allow: ['openai/previous'] },
            models: { 'openai/previous': { agentRuntime: { id: 'codex' } } },
          },
          leia: { model: 'openai/previous' },
        },
      },
    };
    const before = structuredClone(config);
    const plan = createConfigurationPlan(config, 'emori', models, dependencies);

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, true);
    assert.equal(plan.sourceRuntime, 'codex');
    assert.deepEqual(plan.config.agents?.entries?.emori?.model, {
      primary: 'openai/next',
      fallbacks: [],
    });
    assert.deepEqual(plan.config.agents?.entries?.emori?.modelPolicy?.allow, [
      'openai/previous',
      'openai/next',
    ]);
    assert.deepEqual(plan.config.agents?.entries?.leia, before.agents?.entries?.leia);
    plan.config.agents!.entries!.emori!.models!['openai/previous']!.alias = 'changed';
    assert.deepEqual(config, before);
  });

  it('should report a missing agent before consulting model resolvers', () => {
    const unexpected = () => {
      throw new Error('model resolution must follow agent registration');
    };
    const plan = createConfigurationPlan({}, 'emori', models, {
      resolveAllowedModelRef: unexpected,
      resolveCliBackendDispatchEligibility: unexpected,
      resolveDefaultModelForAgent: unexpected,
    });

    assert.equal(plan.status, 'missing-agent');
  });

  it('should normalize missing fallbacks and preserve explicit fallback policy', () => {
    const cases: Array<{
      label: string;
      config: OpenClawConfig;
      expectedModel: { primary: string; fallbacks: string[]; alias?: string };
      changed: boolean;
    }> = [
      {
        label: 'absent model',
        config: configWithModel(),
        expectedModel: { primary: 'openai/next', fallbacks: [] },
        changed: true,
      },
      {
        label: 'bare model string',
        config: configWithModel('openai/previous'),
        expectedModel: { primary: 'openai/next', fallbacks: [] },
        changed: true,
      },
      {
        label: 'matching primary without fallbacks',
        config: configWithModel({ primary: 'openai/next', alias: 'keep-me' }),
        expectedModel: { primary: 'openai/next', fallbacks: [], alias: 'keep-me' },
        changed: true,
      },
      {
        label: 'matching primary with explicitly empty fallbacks',
        config: configWithModel({ primary: 'openai/next', fallbacks: [] }),
        expectedModel: { primary: 'openai/next', fallbacks: [] },
        changed: false,
      },
      {
        label: 'changed primary with ordered explicit fallbacks',
        config: configWithModel({
          primary: 'openai/previous',
          fallbacks: ['anthropic/first', 'google/second'],
        }),
        expectedModel: {
          primary: 'openai/next',
          fallbacks: ['anthropic/first', 'google/second'],
        },
        changed: true,
      },
      {
        label: 'matching primary with ordered explicit fallbacks',
        config: configWithModel({
          primary: 'openai/next',
          fallbacks: ['anthropic/first', 'google/second'],
        }),
        expectedModel: {
          primary: 'openai/next',
          fallbacks: ['anthropic/first', 'google/second'],
        },
        changed: false,
      },
    ];

    for (const { label, config, expectedModel, changed } of cases) {
      const plan = createConfigurationPlan(config, 'emori', models, dependencies);
      assert.equal(plan.status, 'ready', label);
      if (plan.status !== 'ready') continue;
      assert.equal(plan.changed, changed, label);
      assert.deepEqual(plan.config.agents?.entries?.emori?.model, expectedModel, label);

      const repeated = createConfigurationPlan(plan.config, 'emori', models, dependencies);
      assert.equal(repeated.status, 'ready', label);
      if (repeated.status === 'ready') assert.equal(repeated.changed, false, label);
    }
  });
});
