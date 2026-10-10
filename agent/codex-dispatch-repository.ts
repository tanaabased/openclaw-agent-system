import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dispatchGit, type DispatchGit } from './codex-dispatch-project.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
  withPrivateStateLock,
} from '../core/private-state-lock-context.ts';
import type { GitWorktreeConfiguration } from '../tools/git/config-schema.ts';
import GitRepositoryService, {
  ensureRepositoryDirectory,
  RepositoryPreparationError,
  repositoryPathKind,
} from '../tools/git/repository-service.ts';
import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import { gitRemoteIdentity } from '../tools/git/worktree-remote.ts';
import type { GitWorktreeServiceContext } from '../tools/git/worktree-service.ts';

export type DispatchRepositoryPreparation = NonNullable<DispatchRecord['repositoryPreparation']>;

/** only the activated intake owner calls this; neither hooks nor assessment chats prepare repositories. */
export default async function prepareDispatchRepository(
  input: {
    workspace: string;
    configuration: GitWorktreeConfiguration;
    repositoryId: string;
    repository: string;
    cloneUrl: string;
    defaultBranch: string;
    previous?: DispatchRepositoryPreparation;
  },
  dependencies: {
    git?: DispatchGit;
    signal?: AbortSignal;
    authorize(): Promise<void>;
    retain(value: DispatchRepositoryPreparation): Promise<void>;
  },
): Promise<string> {
  const git = dependencies.git ?? dispatchGit;
  const layout = resolveGitWorktreeLayout(await realpath(input.workspace), input.configuration);
  const service = new GitRepositoryService();
  const identity = gitRemoteIdentity(input.cloneUrl);
  if (identity !== 'github.com/' + input.repository.toLowerCase())
    throw new Error('dispatch-repository-identity-invalid');
  const selected = await service.selection(layout, input.repositoryId, input.cloneUrl);
  if (
    input.previous &&
    (input.previous.path !== selected.path || input.previous.identity !== identity)
  )
    throw new RepositoryPreparationError(
      'repository-preparation-changed',
      input.previous.path,
      identity,
    );
  const preparation: DispatchRepositoryPreparation = {
    path: selected.path,
    source: selected.source,
    identity,
    ...(input.previous?.checkout ? { checkout: input.previous.checkout } : {}),
  };
  await dependencies.authorize();
  await dependencies.retain(preparation);
  await ensureRepositoryDirectory(layout.repositoryRoot, true, true);
  const context: GitWorktreeServiceContext = {
    configuration: input.configuration,
    workspaceDir: layout.workspaceDir,
    signal: dependencies.signal,
    git: {
      run: async ({ cwd, argv, signal }) => {
        await dependencies.authorize();
        assertPrivateStateLocksHeld();
        try {
          return {
            exitCode: 0,
            stderr: '',
            stdout: await git(cwd, argv, privateStateLockSignal(signal)),
          };
        } catch (error) {
          if (error instanceof Error && error.message === 'dispatch-project-git-unavailable')
            throw new RepositoryPreparationError(
              'repository-git-unavailable',
              selected.path,
              identity,
            );
          throw error;
        }
      },
    },
  };
  if (selected.kind === 'local') await service.verify(context, selected.path, selected.source);
  const lease = await service.acquire(context, layout, input.repositoryId, input.cloneUrl);
  try {
    return await withPrivateStateLock(lease, async () => {
      context.signal = privateStateLockSignal(dependencies.signal);
      await dependencies.authorize();
      const repository = await service.resolve(
        context,
        layout,
        input.repositoryId,
        input.cloneUrl,
        false,
        true,
      );
      const form = await service.verify(context, repository.path, input.cloneUrl);
      let checkout = repository.path;
      if (form === 'bare') {
        checkout = join(
          layout.worktreeRoot,
          gitWorktreeRepositoryDirectoryName(input.repositoryId).replace(/\.git$/u, ''),
          'codex-project',
        );
        if (preparation.checkout && preparation.checkout !== checkout)
          throw new RepositoryPreparationError(
            'repository-preparation-changed',
            preparation.checkout,
            identity,
          );
        preparation.checkout = checkout;
        await dependencies.retain(preparation);
        await ensureRepositoryDirectory(layout.worktreeRoot, true, true);
        await ensureRepositoryDirectory(dirname(checkout), true, true);
        const run = async (cwd: string, argv: string[]) =>
          (await context.git.run({ cwd, argv, signal: context.signal })).stdout.trim();
        if ((await repositoryPathKind(checkout)) === 'absent') {
          const registered = await run(repository.path, ['worktree', 'list', '--porcelain']);
          if (registered.split('\n').includes('worktree ' + checkout))
            throw new RepositoryPreparationError(
              'repository-workspace-interrupted',
              checkout,
              identity,
            );
          if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input.defaultBranch))
            throw new Error('dispatch-starting-ref-invalid');
          await run(repository.path, ['check-ref-format', 'refs/heads/' + input.defaultBranch]);
          const ref = 'refs/remotes/origin/' + input.defaultBranch;
          await run(repository.path, [
            'fetch',
            '--no-tags',
            'origin',
            'refs/heads/' + input.defaultBranch + ':' + ref,
          ]);
          const commit = await run(repository.path, ['rev-parse', '--verify', ref + '^{commit}']);
          if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('dispatch-starting-ref-invalid');
          await run(repository.path, ['worktree', 'add', '--detach', checkout, commit]);
        }
        if (
          (await service.verify(context, checkout, input.cloneUrl)) !== 'working' ||
          (await realpath(
            await run(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
          )) !==
            (await realpath(
              await run(repository.path, [
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              ]),
            ))
        )
          throw new RepositoryPreparationError('repository-path-conflict', checkout, identity);
      }
      if (preparation.checkout && preparation.checkout !== checkout)
        throw new RepositoryPreparationError(
          'repository-preparation-changed',
          preparation.checkout,
          identity,
        );
      await dependencies.authorize();
      await dependencies.retain({ ...preparation, checkout });
      return checkout;
    });
  } finally {
    await lease.release();
  }
}
