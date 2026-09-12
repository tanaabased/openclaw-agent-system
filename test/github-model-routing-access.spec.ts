import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import GitHubModelRoutingAccess, {
  planGitHubModelRoutingAccess,
} from '../channels/github/model-routing-access.ts';
import type { AgentSystemLifecycleContext } from '../core/lifecycle-registry.ts';

const model = 'openai/gpt-6-astra';
const context: AgentSystemLifecycleContext = {
  manifest: {
    schemaVersion: 1,
    agent: { id: 'emori' },
    github: {
      notifications: { assignmentTypes: ['issue'], approvedActors: [], intervalMinutes: 5 },
    },
    models: {
      default: { model, effort: 'high' },
      low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
      medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
      high: { model, effort: 'high' },
    },
  },
  workspaceDir: '/workspace/emori',
};

function configured(): OpenClawConfig {
  return {
    agents: {
      entries: {
        emori: { model, models: { [model]: { agentRuntime: { id: 'codex' } } } },
        leia: { model: 'anthropic/claude-opus', workspace: '/workspace/leia' },
      },
    },
    plugins: {
      entries: {
        other: { enabled: true, config: { keep: 'unchanged' } },
        'agent-system': {
          enabled: true,
          config: { keep: 'unchanged' },
          hooks: { allowConversationAccess: true },
          llm: {
            allowAgentIdOverride: false,
            allowAuthProfileOverride: true,
            allowModelOverride: false,
            allowedCompletionModels: ['anthropic/claude-opus'],
            allowedModels: ['anthropic/claude-opus'],
          },
        },
      },
    },
  };
}

function fixture() {
  let saved = configured();
  let loaded = structuredClone(saved);
  let mutations = 0;
  const service = new GitHubModelRoutingAccess({
    readConfig: () => structuredClone(saved),
    readRuntimeConfig: () => structuredClone(loaded),
    async mutateConfigFile(input) {
      mutations++;
      assert.equal(input.base, 'source');
      assert.deepEqual(input.afterWrite, { mode: 'auto' });
      const next = structuredClone(saved);
      const result = input.mutate(next);
      saved = next;
      return { result: result === true };
    },
  });
  return {
    service,
    saved: () => saved,
    mutations: () => mutations,
    loadSaved: () => {
      loaded = structuredClone(saved);
    },
  };
}

describe('channels/github/model-routing-access', () => {
  it('should require permissions only for enabled complete tier routing', async () => {
    const variants: AgentSystemLifecycleContext[] = [
      { ...context, manifest: { ...context.manifest, github: undefined } },
      {
        ...context,
        manifest: {
          ...context.manifest,
          github: {
            notifications: {
              assignmentTypes: ['pull-request'],
              approvedActors: [],
              intervalMinutes: 5,
            },
          },
        },
      },
      { ...context, manifest: { ...context.manifest, models: undefined } },
      {
        ...context,
        manifest: {
          ...context.manifest,
          models: { default: { model, effort: 'high' } },
        },
      },
      {
        ...context,
        manifest: {
          ...context.manifest,
          models: {
            default: { model, effort: 'high' },
            low: { model, effort: 'medium' },
            medium: { model, effort: 'high' },
          },
        },
      },
    ];
    let mutations = 0;
    const service = new GitHubModelRoutingAccess({
      readConfig: () => ({}),
      readRuntimeConfig: () => assert.fail('inactive access must not inspect loaded state'),
      async mutateConfigFile() {
        mutations++;
        return { result: true };
      },
    });
    for (const variant of variants) {
      assert.equal(planGitHubModelRoutingAccess({}, variant).kind, 'inactive');
      assert.deepEqual(await service.inspect(variant), []);
      assert.deepEqual(await service.reconcile(variant), { outcomes: [], warnings: [] });
    }
    assert.equal(mutations, 0);
    assert.equal(planGitHubModelRoutingAccess({}, context).kind, 'update');
  });

  it('should add only classifier access and preserve unrelated plugin and agent state', async () => {
    const state = fixture();
    const before = structuredClone(state.saved());
    const first = await state.service.reconcile(context);

    assert.equal(first.outcomes[0]?.status, 'updated');
    assert.equal(first.warnings[0]?.code, 'github-model-routing-loaded-access-stale');
    assert.equal(state.mutations(), 1);
    assert.deepEqual(state.saved().agents, before.agents);
    assert.deepEqual(state.saved().plugins?.entries?.other, before.plugins?.entries?.other);
    assert.deepEqual(state.saved().plugins?.entries?.['agent-system'], {
      ...before.plugins?.entries?.['agent-system'],
      llm: {
        allowAgentIdOverride: true,
        allowAuthProfileOverride: true,
        allowModelOverride: true,
        allowedCompletionModels: ['anthropic/claude-opus', model],
        allowedModels: ['anthropic/claude-opus', model],
      },
    });

    state.loadSaved();
    const second = await state.service.reconcile(context);
    assert.equal(second.outcomes[0]?.status, 'unchanged');
    assert.deepEqual(second.warnings, []);
    assert.equal(state.mutations(), 1);
  });

  it('should distinguish saved drift, stale loaded state, and effective access', async () => {
    const state = fixture();
    assert.equal((await state.service.inspect(context))[0]?.status, 'drift');
    await state.service.reconcile(context);
    assert.equal((await state.service.inspect(context))[0]?.status, 'warning');
    state.loadSaved();
    assert.equal((await state.service.inspect(context))[0]?.status, 'healthy');
  });

  it('should preserve wildcard allowlists without adding narrower entries', async () => {
    const state = fixture();
    const llm = state.saved().plugins!.entries!['agent-system']!.llm!;
    llm.allowedModels = ['*'];
    llm.allowedCompletionModels = ['*'];
    await state.service.reconcile(context);
    assert.deepEqual(state.saved().plugins!.entries!['agent-system']!.llm!.allowedModels, ['*']);
    assert.deepEqual(
      state.saved().plugins!.entries!['agent-system']!.llm!.allowedCompletionModels,
      ['*'],
    );
  });
});
