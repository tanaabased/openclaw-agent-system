import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import createToolAccessLifecycleContribution from '../api/access-lifecycle.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'emori', name: 'EMORI' },
  git: { worktrees: {} },
  github: {},
};
const context = { manifest, workspaceDir: '/workspace/emori' };
const ownedToolNames = [
  'agent_system_git',
  'agent_system_git_worktree',
  'agent_system_github',
] as const;

function toolGrants(currentManifest: AgentManifest) {
  return {
    desired: [
      ...(currentManifest.git === undefined ? [] : ['agent_system_git']),
      ...(currentManifest.git?.worktrees === undefined ? [] : ['agent_system_git_worktree']),
      ...(currentManifest.github === undefined ? [] : ['agent_system_github']),
    ],
    owned: ownedToolNames,
  };
}

function createHarness(config: OpenClawConfig) {
  let mutations = 0;
  const contribution = createToolAccessLifecycleContribution({
    async mutateConfigFile({ mutate }) {
      mutations += 1;
      return { result: mutate(config) as boolean | undefined };
    },
    readConfig: () => config,
    toolGrants,
  });
  return { contribution, mutations: () => mutations };
}

describe('api/access-lifecycle', () => {
  it('should report healthy access when installed grants match the manifest', async () => {
    const { contribution } = createHarness({
      agents: {
        list: [
          {
            id: 'emori',
            tools: {
              alsoAllow: [
                'message',
                'agent_system_git',
                'agent_system_git_worktree',
                'agent_system_github',
              ],
            },
          },
        ],
      },
    });

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'agent-tool-access-ready',
        message: 'OpenClaw tool access for emori matches the manifest.',
        status: 'healthy',
      },
    ]);
  });

  it('should report missing and stale grants as doctor drift', async () => {
    const { contribution } = createHarness({
      agents: {
        list: [
          {
            id: 'emori',
            tools: { alsoAllow: ['message', 'agent_system_github'] },
          },
        ],
      },
    });

    const finding = (
      await contribution.inspect?.({
        ...context,
        manifest: { schemaVersion: 1, agent: manifest.agent, git: {} },
      })
    )?.[0];

    assert.equal(finding?.code, 'agent-tool-access-drift');
    assert.equal(finding?.status, 'drift');
    assert.equal(finding?.message.includes('agent_system_git'), true);
    assert.equal(finding?.message.includes('agent_system_github'), true);
  });

  it('should reconcile exact grants, preserve unrelated entries, and be idempotent', async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: 'emori', tools: { alsoAllow: ['message'] } }],
      },
    };
    const { contribution, mutations } = createHarness(config);

    const installed = await contribution.reconcile?.(context);

    assert.deepEqual(
      installed?.outcomes.map(({ code, status }) => ({ code, status })),
      [{ code: 'set-agent-tool-access', status: 'updated' }],
    );
    assert.deepEqual(config.agents?.list?.[0]?.tools?.alsoAllow, [
      'message',
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
    ]);

    const repeated = await contribution.reconcile?.(context);

    assert.equal(repeated?.outcomes[0]?.status, 'unchanged');
    assert.equal(mutations(), 1);
  });

  it('should add grants to an existing exact allowlist', async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [{ id: 'emori', tools: { allow: ['read'] } }],
      },
    };
    const { contribution } = createHarness(config);

    await contribution.reconcile?.({
      ...context,
      manifest: { schemaVersion: 1, agent: manifest.agent, github: {} },
    });

    assert.deepEqual(config.agents?.list?.[0]?.tools?.allow, ['read', 'agent_system_github']);
    assert.equal(config.agents?.list?.[0]?.tools?.alsoAllow, undefined);
  });

  it('should move owned grants to an existing exact allowlist and clean both lists', async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: 'emori',
            tools: {
              allow: ['read', 'agent_system_git'],
              alsoAllow: [
                'message',
                'agent_system_git',
                'agent_system_git_worktree',
                'agent_system_github',
              ],
            },
          },
        ],
      },
    };
    const { contribution } = createHarness(config);

    await contribution.reconcile?.(context);

    assert.deepEqual(config.agents?.list?.[0]?.tools?.allow, [
      'read',
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
    ]);
    assert.deepEqual(config.agents?.list?.[0]?.tools?.alsoAllow, ['message']);
  });

  it('should remove stale owned grants when capabilities disappear', async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: 'emori',
            tools: {
              alsoAllow: [
                'message',
                'agent_system_git',
                'agent_system_git_worktree',
                'agent_system_github',
              ],
            },
          },
        ],
      },
    };
    const { contribution } = createHarness(config);

    await contribution.reconcile?.({
      ...context,
      manifest: { schemaVersion: 1, agent: manifest.agent },
    });

    assert.deepEqual(config.agents?.list?.[0]?.tools?.alsoAllow, ['message']);
  });

  it('should report a missing agent as drift and refuse reconciliation', async () => {
    const { contribution } = createHarness({ agents: { list: [] } });

    assert.equal((await contribution.inspect?.(context))?.[0]?.status, 'drift');
    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError &&
        error.code === 'agent-tool-access-agent-missing',
    );
  });

  it('should report explicit deny conflicts as blocked and refuse reconciliation', async () => {
    const { contribution, mutations } = createHarness({
      agents: {
        list: [
          {
            id: 'emori',
            tools: {
              alsoAllow: ['agent_system_git', 'agent_system_git_worktree', 'agent_system_github'],
              deny: ['agent_system_github'],
            },
          },
        ],
      },
    });

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'agent-tool-access-denied',
        message: 'OpenClaw agents.list[].tools.deny for emori blocks agent_system_github.',
        remediation:
          'Remove the conflicting entries from agents.list[].tools.deny, then run openclaw agent-system install from this workspace.',
        status: 'blocked',
      },
    ]);
    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError && error.code === 'agent-tool-access-denied',
    );
    assert.equal(mutations(), 0);
  });

  it('should fail when config mutation does not converge', async () => {
    const contribution = createToolAccessLifecycleContribution({
      async mutateConfigFile() {
        return { result: true };
      },
      readConfig: () => ({
        agents: { list: [{ id: 'emori', tools: { alsoAllow: ['message'] } }] },
      }),
      toolGrants,
    });

    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError &&
        error.code === 'agent-tool-access-verification-failed',
    );
  });
});
