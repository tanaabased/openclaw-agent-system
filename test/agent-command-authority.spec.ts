import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import AgentCommandAuthority, {
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
  deniedAgentCommandEnvironment,
} from '../agent/command-authority.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import AgentSystemToolError from '../api/error.ts';

describe('agent/command-authority', () => {
  let root: string;
  let workspaceDir: string;
  let localRepository: string;
  let worktreeRoot: string;
  let otherAgentWorkspace: string;
  let codexHome: string;
  let openClawStateDir: string;
  let authority: AgentCommandAuthority;
  let now: number;
  let loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>;

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
    loaded = {
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

  it('should fail closed when gateway authority is unavailable', async () => {
    await authority.stop();
    const environment = authority.issue('data');

    assert.deepEqual(environment, deniedAgentCommandEnvironment());
    await assert.rejects(
      authority.resolve(environment, workspaceDir),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'agent_not_resolved',
    );
  });

  it('should leave ordinary operator commands unbound', async () => {
    assert.equal(await authority.resolve({}, workspaceDir), undefined);
  });

  it('should revalidate setup execution capabilities and reject oversized requests before dispatch', async () => {
    await authority.stop();
    let calls = 0;
    authority = new AgentCommandAuthority({
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
      },
      rootDir: join(root, 'authority'),
      now: () => now,
      leaseLifetimeMs: 1_000,
      async executeCommand(command, binding) {
        calls++;
        assert.equal(binding.agentId, 'data');
        assert.equal(command.command, 'gh');
        return { exitCode: 0, stdout: 'data', stderr: '' };
      },
    });
    await authority.start();
    const environment = authority.issue('data');
    const binding = await authority.resolve(environment, workspaceDir);
    assert.ok(binding?.executeCommand);
    assert.deepEqual(await binding.executeCommand({ command: 'gh', argv: ['api', 'user'] }), {
      exitCode: 0,
      stdout: 'data',
      stderr: '',
    });
    await assert.rejects(binding.executeCommand({ command: 'gh', argv: ['x'.repeat(1_048_576)] }));
    await assert.rejects(
      binding.executeCommand({ command: 'gh', argv: [], stdin: 'x'.repeat(65_537) }),
    );
    await assert.rejects(
      authority.resolve(
        { ...environment, [agentCommandCapabilityEnvironmentName]: 'x'.repeat(43) },
        workspaceDir,
      ),
    );
    now += 1_001;
    await assert.rejects(binding.executeCommand({ command: 'gh', argv: [] }));
    assert.equal(calls, 1);
  });

  it('should abort and settle in-flight tool execution before authority disposal completes', async () => {
    await authority.stop();
    const started = Promise.withResolvers<void>();
    let disposed = false;
    authority = new AgentCommandAuthority({
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
      },
      rootDir: join(root, 'authority'),
      async executeCommand(_command, _binding, signal) {
        started.resolve();
        await new Promise<void>((resolveAbort) =>
          signal.addEventListener('abort', () => resolveAbort(), { once: true }),
        );
        disposed = true;
        return { exitCode: null, stdout: '', stderr: '' };
      },
    });
    await authority.start();
    const binding = await authority.resolve(authority.issue('data'), workspaceDir);
    assert.ok(binding?.executeCommand);
    const execution = assert.rejects(binding.executeCommand({ command: 'gh', argv: [] }));
    await started.promise;
    await authority.stop();
    await execution;
    assert.equal(disposed, true);
  });

  it('should not expose tool execution on gateway binding-only authorities', async () => {
    const binding = await authority.resolve(authority.issue('data'), workspaceDir);
    assert.ok(binding);
    assert.equal(binding.executeCommand, undefined);
  });
});
