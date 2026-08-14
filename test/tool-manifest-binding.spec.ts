import assert from 'node:assert/strict';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import loadBoundToolManifest from '../lib/tool-manifest-binding.ts';

const workspaceDir = '/workspace/data';

function loadedManifest(
  agentId = 'data',
  loadedWorkspaceDir = workspaceDir,
): Extract<AgentManifestLoadResult, { status: 'loaded' }> {
  return {
    status: 'loaded',
    scope: { agentId, workspaceDir: loadedWorkspaceDir },
    path: `${loadedWorkspaceDir}/agent.yaml`,
    digest: 'manifest-digest',
    manifest: { schemaVersion: 1, agent: { id: agentId } },
    diagnostics: [],
    validationChecks: [],
  };
}

function isUnresolvedToolError(error: unknown): boolean {
  return error instanceof AgentSystemToolError && error.code === 'agent_not_resolved';
}

describe('lib/tool-manifest-binding', () => {
  it('should bind native tool context to its exact agent workspace', async () => {
    const calls: string[] = [];
    const result = await loadBoundToolManifest(
      {
        async loadForAgentId(agentId, trigger) {
          calls.push(`${agentId}:${trigger}`);
          return loadedManifest(agentId);
        },
        async loadForCommandDirectory() {
          throw new Error('workspace discovery should not run');
        },
      },
      {
        source: 'tool',
        toolContext: { agentId: ' data ', workspaceDir: `${workspaceDir}/.` } as never,
      },
    );

    assert.equal(result.manifest.agent.id, 'data');
    assert.deepEqual(calls, ['data:cli']);
  });

  it('should reject incomplete or mismatched native tool context', async () => {
    const service = {
      async loadForAgentId() {
        return loadedManifest('data', '/workspace/other');
      },
      async loadForCommandDirectory() {
        return loadedManifest();
      },
    };

    await assert.rejects(
      loadBoundToolManifest(service, { source: 'tool', toolContext: {} as never }),
      isUnresolvedToolError,
    );
    await assert.rejects(
      loadBoundToolManifest(service, {
        source: 'tool',
        toolContext: { agentId: 'data', workspaceDir } as never,
      }),
      isUnresolvedToolError,
    );
  });

  it('should resolve an explicit command agent without workspace discovery', async () => {
    const calls: string[] = [];
    const result = await loadBoundToolManifest(
      {
        async loadForAgentId(agentId, trigger) {
          calls.push(`${agentId}:${trigger}`);
          return loadedManifest(agentId);
        },
        async loadForCommandDirectory() {
          throw new Error('workspace discovery should not run');
        },
      },
      { agentId: 'data', source: 'command' },
    );

    assert.equal(result.scope.workspaceDir, workspaceDir);
    assert.deepEqual(calls, ['data:cli']);
  });

  it('should bind an agent command to its authoritative agent instead of caller cwd discovery', async () => {
    const calls: string[] = [];
    const result = await loadBoundToolManifest(
      {
        async loadForAgentId(agentId, trigger) {
          calls.push(`${agentId}:${trigger}`);
          return loadedManifest(agentId);
        },
        async loadForCommandDirectory() {
          throw new Error('agent command cwd discovery should not run');
        },
      },
      {
        agentId: 'data',
        source: 'agent-command',
        workspaceDir: '/repos/canon',
      },
    );

    assert.equal(result.manifest.agent.id, 'data');
    assert.deepEqual(calls, ['data:cli']);
  });

  it('should reject an explicit command agent that resolves to another identity', async () => {
    await assert.rejects(
      loadBoundToolManifest(
        {
          async loadForAgentId() {
            return loadedManifest('emori');
          },
          async loadForCommandDirectory() {
            return loadedManifest();
          },
        },
        { agentId: 'data', source: 'command' },
      ),
      isUnresolvedToolError,
    );
  });

  it('should discover a command workspace and rebind its declared agent', async () => {
    const calls: string[] = [];
    const result = await loadBoundToolManifest(
      {
        async loadForAgentId(agentId, trigger) {
          calls.push(`agent:${agentId}:${trigger}`);
          return loadedManifest(agentId);
        },
        async loadForCommandDirectory(path, trigger) {
          calls.push(`command:${path}:${trigger}`);
          return loadedManifest();
        },
      },
      { source: 'command', workspaceDir },
    );

    assert.equal(result.manifest.agent.id, 'data');
    assert.deepEqual(calls, [`command:${workspaceDir}:cli`, 'agent:data:cli']);
  });

  it('should fail closed when workspace discovery or rebinding cannot be proven', async () => {
    const unmanaged: AgentManifestLoadResult = {
      status: 'unmanaged',
      scope: { workspaceDir },
      diagnostics: [],
    };
    const service = {
      async loadForAgentId() {
        return loadedManifest('data', '/workspace/other');
      },
      async loadForCommandDirectory() {
        return unmanaged;
      },
    };

    await assert.rejects(
      loadBoundToolManifest(service, { source: 'command' }),
      isUnresolvedToolError,
    );
    await assert.rejects(
      loadBoundToolManifest(service, { source: 'command', workspaceDir }),
      isUnresolvedToolError,
    );
    await assert.rejects(
      loadBoundToolManifest(
        { ...service, loadForCommandDirectory: async () => loadedManifest() },
        { source: 'command', workspaceDir },
      ),
      isUnresolvedToolError,
    );
  });
});
