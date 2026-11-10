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

  it('should bind two agents sharing a local source only to their own worktrees', async () => {
    const source = join(root, 'source');
    const repository = join(source, '.git');
    const agents = [
      { id: 'data', workspace, configuration: { repositories: { local: { fixture: source } } } },
      {
        id: 'other',
        workspace: join(root, 'other'),
        configuration: {
          root: join(root, 'other-worktrees'),
          repositories: { local: { fixture: source } },
        },
      },
    ];
    const checkouts = agents.map((agent) =>
      join(
        agent.configuration.root ?? join(agent.workspace, '.agent-system/worktrees'),
        'fixture',
        'task',
      ),
    );
    for (const [index, agent] of agents.entries()) {
      await mkdir(agent.workspace, { recursive: true });
      const checkout = checkouts[index]!;
      const registration = join(repository, 'worktrees', agent.id);
      await mkdir(checkout, { recursive: true });
      await mkdir(registration, { recursive: true });
      await writeFile(join(checkout, '.git'), `gitdir: ${registration}\n`);
      await writeFile(join(registration, 'commondir'), '../..\n');
      await writeFile(join(registration, 'gitdir'), `${checkout}/.git\n`);
    }
    for (const [index, agent] of agents.entries()) {
      const checkout = checkouts[index]!;
      const canonical: typeof loaded = {
        ...loaded,
        scope: { agentId: agent.id, workspaceDir: agent.workspace },
        manifest: {
          schemaVersion: 1,
          agent: { id: agent.id },
          git: { worktrees: agent.configuration },
        },
      };
      const service = {
        loadForAgentId: async () => canonical,
        loadForCommandDirectory: async () => canonical,
      };
      const toolContext = {
        ...context(),
        agentId: agent.id,
        sessionKey: `agent:${agent.id}:test`,
        workspaceDir: checkout,
      };
      assert.equal(
        await isManagedWorktreeWorkspace(agent.workspace, agent.configuration, checkout),
        true,
      );
      assert.equal(
        (await loadBoundToolManifest(service, { source: 'tool', toolContext })).scope.workspaceDir,
        agent.workspace,
      );
      await writeFile(join(agent.workspace, 'SOUL.md'), `canonical ${agent.id}`);
      assert.ok(
        (await worktreeGuidance(canonical, toolContext))?.includes(`canonical ${agent.id}`),
      );
      await assert.rejects(
        loadBoundToolManifest(service, {
          source: 'tool',
          toolContext: { ...toolContext, workspaceDir: checkouts[1 - index]! },
        }),
        { code: 'agent_not_resolved' },
      );
      assert.equal(
        await isManagedWorktreeWorkspace(agent.workspace, agent.configuration, source),
        false,
      );
    }
  });

  it('should reject broken registration and aliases for external backing repositories', async () => {
    const repository = join(root, 'source/.git');
    const externalAdmin = join(repository, 'worktrees/task');
    await mkdir(externalAdmin, { recursive: true });
    await writeFile(join(cwd, '.git'), `gitdir: ${externalAdmin}\n`);
    await writeFile(join(externalAdmin, 'commondir'), '../..\n');
    await writeFile(join(externalAdmin, 'gitdir'), `${cwd}/.git\n`);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), true);
    await writeFile(join(externalAdmin, 'gitdir'), `${workspace}/.git\n`);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
    await writeFile(join(externalAdmin, 'gitdir'), `${cwd}/.git\n`);
    await writeFile(join(externalAdmin, 'commondir'), '../../elsewhere\n');
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
    await writeFile(join(externalAdmin, 'commondir'), '../..\n');
    const alias = join(root, 'source-alias');
    await symlink(repository, alias);
    await writeFile(join(cwd, '.git'), `gitdir: ${alias}/worktrees/task\n`);
    assert.equal(await isManagedWorktreeWorkspace(workspace, {}, cwd), false);
  });

  it('should reject missing registration and aliases before reading their metadata', async () => {
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
    assert.equal(result!.includes('private partner'), false);
    assert.equal(result!.includes('private memory'), false);
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
