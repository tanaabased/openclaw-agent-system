import assert from 'node:assert/strict';

import AgentSystemToolError from '../api/error.ts';
import { createGitWorktreeToolDefinition } from '../tools/git/worktree-tool.ts';

function definitionFixture(options: { cleanupFails?: boolean } = {}) {
  const events: string[] = [];
  const definition = createGitWorktreeToolDefinition({
    runnerFactory: {
      async acquire(configuration, _scope, acquireOptions) {
        assert.equal(configuration.identity.name, 'Data');
        events.push(`acquire:${acquireOptions?.authentication === true}`);
        return {
          async dispose() {
            events.push('dispose');
            if (options.cleanupFails) throw new Error('private cleanup detail');
          },
          git: {
            async run() {
              return { exitCode: 0, stderr: '', stdout: '' };
            },
          },
        };
      },
    },
    service: {
      async list(_context, repositoryId) {
        events.push(`list:${repositoryId ?? 'all'}`);
        return [];
      },
      async prepare(_context, input) {
        events.push(`prepare:${input.repositoryId}:${input.workId}`);
        return { workId: input.workId } as never;
      },
      async remove(_context, repositoryId, workId) {
        events.push(`remove:${repositoryId}:${workId}`);
        return { workId } as never;
      },
    },
  });
  const declared = definition.configuration.read({
    agent: { email: 'data@example.com', id: 'data', name: 'Data' },
    git: { worktrees: {} },
    schemaVersion: 1,
  });
  assert.ok(declared);
  const configuration = definition.configuration.resolve(declared, {
    resolve(value) {
      return typeof value === 'string' ? value : 'data@example.com';
    },
  });
  const scope = {
    agentId: 'data',
    resolveEnvironment: () => undefined,
    source: 'tool' as const,
    workspaceDir: '/workspace',
  };
  return { configuration, declared, definition, events, scope };
}

describe('tools/git/worktree-tool', () => {
  it('should expose only prepare, list, and remove through one definition', async () => {
    const { configuration, declared, definition, events, scope } = definitionFixture();

    await definition.execute(
      {
        action: 'prepare',
        baseRef: 'origin/main',
        repository: { cloneUrl: 'git@github.com:example/repo.git', id: 'repo' },
        workId: 'task-1',
      },
      configuration,
      scope,
    );
    await definition.execute({ action: 'list', repositoryId: 'repo' }, configuration, scope);
    await definition.execute(
      { action: 'remove', repositoryId: 'repo', workId: 'task-1' },
      configuration,
      scope,
    );

    assert.deepEqual(events, [
      'acquire:true',
      'prepare:repo:task-1',
      'dispose',
      'acquire:false',
      'list:repo',
      'dispose',
      'acquire:false',
      'remove:repo:task-1',
      'dispose',
    ]);
    assert.equal(definition.tool.classify({ action: 'list' }, declared).risk, 'read');
    assert.deepEqual(
      definition.tool.classify(
        { action: 'remove', repositoryId: 'repo', workId: 'task-1' },
        declared,
      ),
      {
        action: 'git.worktree.remove',
        resources: [
          { id: 'repo', type: 'git-repository' },
          { id: 'task-1', type: 'git-worktree' },
        ],
        risk: 'write',
        summary: 'Remove a Git worktree',
      },
    );
  });

  it('should parse the registered command route and reject unsupported inputs', () => {
    const { declared, definition } = definitionFixture();

    assert.deepEqual(
      definition.tool.inputFromCommand([
        'prepare',
        'repo',
        'task-1',
        'origin/main',
        '--clone-url',
        'https://example.com/repo.git',
      ]),
      {
        action: 'prepare',
        baseRef: 'origin/main',
        repository: { cloneUrl: 'https://example.com/repo.git', id: 'repo' },
        workId: 'task-1',
      },
    );
    assert.deepEqual(definition.tool.inputFromCommand(['list', 'repo']), {
      action: 'list',
      repositoryId: 'repo',
    });
    assert.deepEqual(definition.tool.inputFromCommand(['remove', 'repo', 'task-1']), {
      action: 'remove',
      repositoryId: 'repo',
      workId: 'task-1',
    });
    assert.throws(() => definition.tool.inputFromCommand(['attach', 'task-1']));
    assert.throws(() =>
      definition.tool.inputFromCommand([
        'prepare',
        'repo',
        'task-1',
        'origin/main',
        '--branch',
        'agent/task-1',
      ]),
    );
    assert.throws(() =>
      definition.tool.validate?.(
        {
          action: 'prepare',
          baseRef: 'origin/main',
          branch: 'agent/task-1',
          repository: { id: 'repo' },
          workId: 'task-1',
        } as never,
        declared,
      ),
    );
    assert.throws(() =>
      definition.tool.validate?.(
        {
          action: 'remove',
          force: true,
          repositoryId: 'repo',
          workId: 'task-1',
        } as never,
        declared,
      ),
    );
    assert.throws(() =>
      definition.tool.validate?.(
        {
          action: 'prepare',
          baseRef: 'origin/main',
          repository: { cloneUrl: '../local', id: 'repo' },
          workId: 'task-1',
        },
        declared,
      ),
    );
  });

  it('should report invocation resource cleanup failures', async () => {
    const { configuration, definition, scope } = definitionFixture({ cleanupFails: true });

    await assert.rejects(
      definition.execute({ action: 'list' }, configuration, scope),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'resource_cleanup_failed',
    );
  });
});
