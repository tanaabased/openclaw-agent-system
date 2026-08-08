import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentManifestService from '../lib/agent-manifest-service.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-service-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

function createService(
  workspaces: Record<string, string>,
  validateManifest?: NonNullable<
    ConstructorParameters<typeof AgentManifestService>[0]['validateManifest']
  >,
) {
  const logs = {
    debug: [] as string[],
    error: [] as string[],
    info: [] as string[],
    warn: [] as string[],
  };
  let workspaceResolutions = 0;
  const service = new AgentManifestService({
    getConfig: () => ({}),
    logger: {
      debug: (message) => logs.debug.push(message),
      error: (message) => logs.error.push(message),
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    parseSessionAgentId(sessionKey) {
      return /^agent:([^:]+):/.exec(sessionKey)?.[1];
    },
    resolveAgentWorkspaceDir(_config, agentId) {
      workspaceResolutions += 1;
      const workspace = workspaces[agentId];
      if (!workspace) throw new Error('unknown agent');
      return workspace;
    },
    ...(validateManifest ? { validateManifest } : {}),
  });

  return { service, logs, workspaceResolutions: () => workspaceResolutions };
}

describe('lib/agent-manifest-service', () => {
  it('should load and bind a valid manifest to the active agent', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: tanaabot\n');
    const { service, logs } = createService({ tanaabot: root });

    const result = await service.loadForRuntimeContext({ agentId: 'tanaabot' }, 'session_start');

    assert.equal(result.status, 'loaded');
    assert.equal(result.status === 'loaded' ? result.manifest.agent.id : undefined, 'tanaabot');
    assert.equal(
      logs.info.some((message) => message.includes('manifest_loaded')),
      true,
    );
  });

  it('should remain inactive when runtime context has no authoritative agent', async () => {
    const { service, workspaceResolutions } = createService({});

    const result = await service.loadForRuntimeContext(
      { sessionKey: 'legacy-session' },
      'session_start',
    );

    assert.equal(result.status, 'unresolved');
    assert.equal(workspaceResolutions(), 0);
  });

  it('should reject a manifest bound to a different agent', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: other\n');
    const { service } = createService({ tanaabot: root });

    const result = await service.loadForAgentId('tanaabot');

    assert.equal(result.status, 'invalid');
    assert.equal(
      result.diagnostics.some(({ code }) => code === 'agent-id-mismatch'),
      true,
    );
  });

  it('should reject lifecycle declaration errors with contributor attribution', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: tanaabot\n');
    const { service } = createService({ tanaabot: root }, () => ({
      checks: [],
      diagnostics: [
        {
          code: 'github-declaration-invalid',
          component: 'github',
          message: 'The GitHub declaration is invalid.',
          severity: 'error',
        },
      ],
    }));

    const result = await service.loadForAgentId('tanaabot');

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.diagnostics.at(-1), {
      code: 'github-declaration-invalid',
      component: 'github',
      message: 'The GitHub declaration is invalid.',
      severity: 'error',
    });
  });

  it('should carry successful lifecycle checks with the loaded manifest', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: tanaabot\n');
    const { service } = createService({ tanaabot: root }, () => ({
      checks: [
        {
          code: 'agent-declaration-valid',
          component: 'agent',
          message: 'OpenClaw agent declaration',
          status: 'valid',
        },
      ],
      diagnostics: [],
    }));

    const result = await service.loadForAgentId('tanaabot');

    assert.equal(result.status, 'loaded');
    if (result.status !== 'loaded') return;
    assert.deepEqual(result.validationChecks, [
      {
        code: 'agent-declaration-valid',
        component: 'agent',
        message: 'OpenClaw agent declaration',
        status: 'valid',
      },
    ]);
  });

  it('should cache unchanged manifests and reload a changed file', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'agent.yaml');
    await writeFile(path, 'schema-version: 1\nagent:\n  id: tanaabot\n  name: One\n');
    const { service, logs } = createService({ tanaabot: root });

    const first = await service.loadForAgentId('tanaabot');
    const cached = await service.loadForAgentId('tanaabot');
    await writeFile(path, 'schema-version: 1\nagent:\n  id: tanaabot\n  name: Longer Name\n');
    const changed = await service.loadForAgentId('tanaabot');

    assert.strictEqual(cached, first);
    assert.notEqual(
      first.status === 'loaded' ? first.digest : undefined,
      changed.status === 'loaded' ? changed.digest : undefined,
    );
    assert.equal(logs.info.filter((message) => message.includes('manifest_loaded')).length, 1);
    assert.equal(logs.info.filter((message) => message.includes('manifest_changed')).length, 1);
  });

  it('should never include manifest values in runtime logs', async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent:\n  id: tanaabot\nsecret-token: extremely-sensitive\n',
    );
    const { service, logs } = createService({ tanaabot: root });

    await service.loadForAgentId('tanaabot');

    assert.equal(Object.values(logs).flat().join('\n').includes('extremely-sensitive'), false);
  });
});
