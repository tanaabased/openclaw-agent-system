import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import createAgentLifecycleContribution, {
  type AgentLifecycleDependencies,
} from '../agent/lifecycle.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data', name: 'Data', avatar: 'avatar.png' },
};
const context = { manifest, workspaceDir: '/workspace/data' };

function successfulResult() {
  return { code: 0, stderr: '', stdout: '{}' };
}

describe('agent/lifecycle', () => {
  it('should validate the foundational agent declaration', () => {
    const contribution = createAgentLifecycleContribution({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return successfulResult();
      },
    });

    assert.deepEqual(contribution.validate?.(context), {
      code: 'agent-declaration-valid',
      summary: 'OpenClaw agent declaration',
    });
  });

  it('should add an absent agent, set identity, and verify the result', async () => {
    let config: OpenClawConfig = {};
    const commands: string[][] = [];
    const contribution = createAgentLifecycleContribution({
      readConfig: () => config,
      async runOpenClawCommand(args) {
        commands.push(args);
        config =
          args[1] === 'add'
            ? { agents: { list: [{ id: 'data', workspace: '/workspace/data' }] } }
            : {
                agents: {
                  list: [
                    {
                      id: 'data',
                      identity: { avatar: 'avatar.png', name: 'Data' },
                      workspace: '/workspace/data',
                    },
                  ],
                },
              };
        return successfulResult();
      },
    });

    const result = await contribution.reconcile?.(context);

    assert.deepEqual(
      result?.outcomes.map(({ code, status }) => ({ code, status })),
      [
        { code: 'add-agent', status: 'created' },
        { code: 'set-identity', status: 'updated' },
      ],
    );
    assert.equal(commands.length, 2);
  });

  it('should report and preserve matching agent state as unchanged', async () => {
    const contribution = createAgentLifecycleContribution({
      readConfig: () => ({
        agents: {
          list: [
            {
              id: 'data',
              identity: { avatar: 'avatar.png', name: 'Data' },
              workspace: '/workspace/data',
            },
          ],
        },
      }),
      async runOpenClawCommand() {
        throw new Error('command should not run');
      },
    });

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'agent-ready',
        message: 'OpenClaw registration and identity for data match the manifest.',
        status: 'healthy',
      },
    ]);
    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'agent-unchanged',
          message: 'OpenClaw registration and identity for data',
          status: 'unchanged',
        },
      ],
    });
  });

  it('should distinguish missing registration from identity drift', async () => {
    let config: OpenClawConfig = {};
    const dependencies: AgentLifecycleDependencies = {
      readConfig: () => config,
      async runOpenClawCommand() {
        return successfulResult();
      },
    };
    const contribution = createAgentLifecycleContribution(dependencies);

    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-registration-drift');
    config = {
      agents: {
        list: [
          {
            id: 'data',
            identity: { avatar: 'avatar.png', name: 'Other' },
            workspace: '/workspace/data',
          },
        ],
      },
    };
    assert.equal((await contribution.inspect?.(context))?.[0]?.code, 'agent-identity-drift');
  });

  it('should block a workspace conflict without mutation', async () => {
    const contribution = createAgentLifecycleContribution({
      readConfig: () => ({
        agents: { list: [{ id: 'data', workspace: '/workspace/other' }] },
      }),
      async runOpenClawCommand() {
        throw new Error('command should not run');
      },
    });

    assert.equal((await contribution.inspect?.(context))?.[0]?.status, 'blocked');
    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) => {
        assert.equal(error instanceof AgentSystemLifecycleError, true);
        if (error instanceof AgentSystemLifecycleError) {
          assert.equal(error.component, 'agent');
          assert.equal(error.code, 'agent-workspace-conflict');
        }
        return true;
      },
    );
  });

  it('should resolve an environment-backed name before openclaw access', async () => {
    const referencedManifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'data', name: { fromEnvironment: 'AGENT_NAME' } },
    };
    const events: string[] = [];
    let config: OpenClawConfig = {};
    const contribution = createAgentLifecycleContribution({
      environmentService: {
        async loadForWorkspace(workspaceDir, expectedAgentId) {
          events.push('environment');
          assert.equal(expectedAgentId, 'data');
          return {
            status: 'loaded',
            scope: { agentId: 'data', workspaceDir },
            path: `${workspaceDir}/agent.yaml`,
            digest: 'manifest-digest',
            manifest: referencedManifest,
            diagnostics: [],
            validationChecks: [],
            environment: { values: { AGENT_NAME: 'Data' }, variables: [] },
          };
        },
      },
      readConfig() {
        events.push('config');
        return config;
      },
      async runOpenClawCommand(args) {
        events.push(`command:${args[1]}`);
        config =
          args[1] === 'add'
            ? { agents: { list: [{ id: 'data', workspace: '/workspace/data' }] } }
            : {
                agents: {
                  list: [
                    {
                      id: 'data',
                      identity: { name: 'Data' },
                      workspace: '/workspace/data',
                    },
                  ],
                },
              };
        return successfulResult();
      },
    });

    await contribution.reconcile?.({
      manifest: referencedManifest,
      workspaceDir: '/workspace/data',
    });

    assert.deepEqual(events, [
      'environment',
      'config',
      'command:add',
      'command:set-identity',
      'config',
    ]);
  });

  it('should expose declaration failures as blocked doctor findings', async () => {
    const contribution = createAgentLifecycleContribution({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return successfulResult();
      },
    });
    const missingName = {
      manifest: { schemaVersion: 1, agent: { id: 'data' } } as AgentManifest,
      workspaceDir: '/workspace/data',
    };

    assert.deepEqual(await contribution.inspect?.(missingName), [
      {
        code: 'agent-name-required',
        message: 'Agent System install requires agent.name in the manifest.',
        remediation: 'Correct the agent declaration or environment, then run install.',
        status: 'blocked',
      },
    ]);
  });

  it('should fail when post-install verification does not converge', async () => {
    const contribution = createAgentLifecycleContribution({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return successfulResult();
      },
    });

    await assert.rejects(
      () => contribution.reconcile!(context),
      (error: unknown) =>
        error instanceof AgentSystemLifecycleError && error.code === 'agent-verification-failed',
    );
  });
});
