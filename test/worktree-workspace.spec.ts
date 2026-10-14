import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import isManagedWorktreeWorkspace from '../tools/git/worktree-workspace.ts';
import loadBoundToolManifest from '../api/manifest-binding.ts';
import worktreeGuidance from '../agent/worktree-guidance.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

describe('managed worktree workspace binding', () => {
  let root: string;
  let workspace: string;
  let cwd: string;
  let admin: string;
  let loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>;
  const context = () => ({
    agentId: 'data',
    sessionKey: 'agent:data:dashboard:fixture',
    sessionId: 'one',
    workspaceDir: cwd,
  });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agent-workspace-')));
    workspace = join(root, 'agent');
    cwd = join(workspace, '.agent-system/worktrees/repo-id/issue-id');
    admin = join(workspace, '.agent-system/repositories/repo-id.git/worktrees/issue-id');
    await mkdir(cwd, { recursive: true });
    await mkdir(admin, { recursive: true });
    await writeFile(join(cwd, '.git'), `gitdir: ${admin}\n`);
    await writeFile(join(admin, 'commondir'), '../..\n');
    await writeFile(join(admin, 'gitdir'), `${cwd}/.git\n`);
    loaded = {
      status: 'loaded',
      scope: { agentId: 'data', workspaceDir: workspace },
      path: join(workspace, '.agent-system/agent.yaml'),
      digest: 'fixture',
      diagnostics: [],
      validationChecks: [],
      manifest: { schemaVersion: 1, agent: { id: 'data' }, git: { worktrees: {} } },
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('should retain canonical configuration for a verified linked worktree', async () => {
    const service = {
      loadForAgentId: async () => loaded,
      loadForCommandDirectory: async () => loaded,
    };
    const result = await loadBoundToolManifest(service, { source: 'tool', toolContext: context() });
    assert.equal(result.scope.workspaceDir, workspace);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), true);
    await assert.rejects(
      loadBoundToolManifest(service, {
        source: 'tool',
        toolContext: { ...context(), sessionKey: 'agent:other:dashboard:fixture' },
      }),
    );
    await assert.rejects(
      loadBoundToolManifest(service, {
        source: 'tool',
        toolContext: { ...context(), sessionId: undefined },
      }),
    );
    loaded.manifest.agent.id = 'other';
    await assert.rejects(
      loadBoundToolManifest(service, { source: 'tool', toolContext: context() }),
    );
  });

  it('should reject arbitrary directories, missing configuration and broken registration', async () => {
    assert.equal(await isManagedWorktreeWorkspace(workspace, undefined, cwd), false);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, workspace), false);
    await rm(join(cwd, '.git'));
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
    await writeFile(join(cwd, '.git'), `gitdir: ${admin}\n`);
    await writeFile(join(admin, 'gitdir'), `${workspace}/.git\n`);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
  });

  it('should reject foreign repositories and aliases before reading their metadata', async () => {
    const outside = join(root, 'foreign');
    await mkdir(outside);
    await writeFile(join(cwd, '.git'), `gitdir: ${outside}/worktrees/item\n`);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
    await rm(join(cwd, '.git'));
    await symlink(join(admin, 'gitdir'), join(cwd, '.git'));
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
    await rm(join(cwd, '.git'));
    await writeFile(join(cwd, '.git'), `gitdir: ${admin}\n`);
    const alias = join(root, 'alias');
    await symlink(workspace, alias);
    assert.equal(await isManagedWorktreeWorkspace(alias, {}, cwd.replace(workspace, alias)), false);
  });

  it('should compose public canonical guidance without changing cwd or copying private context', async () => {
    for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'GOALS.md'])
      await writeFile(join(workspace, file), `canonical ${file}`);
    await writeFile(join(workspace, 'USER.md'), 'private partner');
    await writeFile(join(workspace, 'MEMORY.md'), 'private memory');
    await writeFile(join(cwd, 'AGENTS.md'), 'repository-only marker');
    const before = process.cwd();
    const result = await worktreeGuidance(loaded, context());
    assert.match(result!, /canonical SOUL.md/u);
    assert.match(result!, /target repository instructions/u);
    assert.equal(result!.includes('private'), false);
    assert.equal(result!.includes('repository-only marker'), false);
    assert.equal(process.cwd(), before);
    assert.equal(
      await worktreeGuidance(loaded, { ...context(), workspaceDir: workspace }),
      undefined,
    );
    await rm(join(cwd, '.git'));
    assert.equal(await worktreeGuidance(loaded, context()), undefined);
  });

  it('should tolerate absent optional guidance and reject unsafe guidance', async () => {
    assert.equal(await worktreeGuidance(loaded, context()), undefined);
    await writeFile(join(workspace, 'SOUL.md'), 'canonical soul');
    assert.match((await worktreeGuidance(loaded, context()))!, /canonical soul/u);
    await symlink(join(workspace, 'SOUL.md'), join(workspace, 'AGENTS.md'));
    await assert.rejects(worktreeGuidance(loaded, context()), /guidance-unavailable/u);
  });
});
