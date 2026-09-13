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

describe('agent/model-configuration-plan', () => {
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
    assert.equal(plan.config.agents?.entries?.emori?.model, 'openai/next');
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
});
