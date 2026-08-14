import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import AgentCommandAuthority, {
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
} from '../lib/agent-command-authority.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import AgentSystemToolError from '../lib/tool-error.ts';

describe('lib/agent-command-authority', () => {
  let root: string;
  let workspaceDir: string;
  let localRepository: string;
  let worktreeRoot: string;
  let otherAgentWorkspace: string;
  let codexHome: string;
  let openClawStateDir: string;
  let authority: AgentCommandAuthority;
  let now: number;

  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/agent-system-command-authority-'));
    workspaceDir = join(root, 'workspace-data');
    localRepository = join(root, 'canon');
    worktreeRoot = join(workspaceDir, '.agent-system', 'worktrees');
    otherAgentWorkspace = join(root, 'workspace-emori');
    codexHome = join(root, 'agents', 'data', 'agent', 'codex-home');
    openClawStateDir = join(root, 'openclaw-state');
    await Promise.all(
      [
        workspaceDir,
        localRepository,
        worktreeRoot,
        otherAgentWorkspace,
        codexHome,
        openClawStateDir,
      ].map((path) => mkdir(path, { recursive: true })),
    );
    now = 10_000;
    const loaded: AgentManifestLoadResult = {
      status: 'loaded',
      scope: { agentId: 'data', workspaceDir },
      path: join(workspaceDir, '.agent-system', 'agent.yaml'),
      digest: 'manifest-digest',
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        git: {
          worktrees: {
            repositories: { local: { canon: localRepository } },
            root: worktreeRoot,
          },
        },
      },
      diagnostics: [],
      validationChecks: [],
    };
    authority = new AgentCommandAuthority({
      currentUid: process.getuid?.(),
      leaseLifetimeMs: 1_000,
      manifestService: {
        async loadForAgentId(agentId) {
          return agentId === 'data' ? loaded : { status: 'unresolved', diagnostics: [] };
        },
      },
      now: () => now,
      async resolveCodexAgentId(context) {
        return context.codexHome === codexHome &&
          (context.openClawStateDir === undefined || context.openClawStateDir === openClawStateDir)
          ? 'data'
          : undefined;
      },
      rootDir: join(root, 'authority'),
    });
    await authority.start();
  });

  afterEach(async () => {
    await authority.stop();
    await rm(root, { force: true, recursive: true });
  });

  it('should bind an issued capability to the active agent and admitted repository', async () => {
    const repositoryDirectory = join(localRepository, 'packages', 'task-author');
    await mkdir(repositoryDirectory, { recursive: true });
    const environment = authority.issue('data');
    assert.ok(environment?.[agentCommandAuthorityEnvironmentName]);
    assert.ok(environment?.[agentCommandCapabilityEnvironmentName]);

    const binding = await authority.resolve(environment, repositoryDirectory);

    assert.equal(binding?.agentId, 'data');
    assert.equal(binding?.workingDirectory, repositoryDirectory);
    assert.deepEqual(
      [...(binding?.admittedWorkingDirectories ?? [])].sort(),
      [workspaceDir, worktreeRoot, localRepository].sort(),
    );
  });

  it('should bind OpenClaw Codex exec descendants through the harness home', async () => {
    const binding = await authority.resolve(
      {
        CODEX_HOME: codexHome,
        CODEX_THREAD_ID: 'codex-thread-one',
        OPENCLAW_STATE_DIR: openClawStateDir,
      },
      localRepository,
    );

    assert.equal(binding?.agentId, 'data');
    assert.equal(binding?.workingDirectory, localRepository);
  });

  it('should deny an OpenClaw Codex descendant after it changes into another agent workspace', async () => {
    await assert.rejects(
      authority.resolve(
        {
          CODEX_HOME: codexHome,
          CODEX_THREAD_ID: 'codex-thread-one',
        },
        otherAgentWorkspace,
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'agent_not_resolved',
    );
  });

  it('should bind an OpenClaw Codex descendant under the default state profile', async () => {
    const binding = await authority.resolve(
      { CODEX_HOME: codexHome, CODEX_THREAD_ID: 'codex-thread-one' },
      workspaceDir,
    );

    assert.equal(binding?.agentId, 'data');
    assert.equal(binding?.workingDirectory, workspaceDir);
  });

  it('should leave standalone Codex descendants unbound', async () => {
    assert.equal(
      await authority.resolve(
        { CODEX_HOME: '/user/codex-home', CODEX_THREAD_ID: 'standalone-thread' },
        workspaceDir,
      ),
      undefined,
    );
  });

  it('should fail closed for an unrecognized OpenClaw Codex home', async () => {
    await assert.rejects(
      authority.resolve(
        {
          CODEX_HOME: join(root, 'agents', 'other', 'agent', 'codex-home'),
          CODEX_THREAD_ID: 'codex-thread-one',
          OPENCLAW_STATE_DIR: openClawStateDir,
        },
        workspaceDir,
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'agent_not_resolved',
    );
  });

  it('should deny cwd changes into another agent workspace', async () => {
    const environment = authority.issue('data');
    assert.ok(environment);

    await assert.rejects(
      authority.resolve(environment, otherAgentWorkspace),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'agent_not_resolved',
    );
  });

  it('should reject forged and expired capabilities without falling back to cwd discovery', async () => {
    const environment = authority.issue('data');
    assert.ok(environment);
    const forged = {
      ...environment,
      [agentCommandCapabilityEnvironmentName]: 'x'.repeat(43),
    };

    await assert.rejects(authority.resolve(forged, workspaceDir));
    now += 1_001;
    await assert.rejects(authority.resolve(environment, workspaceDir));
  });

  it('should leave ordinary operator commands unbound', async () => {
    assert.equal(await authority.resolve({}, workspaceDir), undefined);
  });
});
