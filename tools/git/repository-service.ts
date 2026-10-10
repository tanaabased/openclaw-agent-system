import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';
import acquirePrivateStateFileLock, {
  privateStateFileLockBusyErrorCode,
  type PrivateStateFileLockHandle,
} from '../../core/private-state-file-lock.ts';
import PrivateStateFile from '../../core/private-state-file.ts';
import abortableDelay from '../../utils/abortable-delay.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import GitCommandError from './command-error.ts';
import type { GitWorktreeLayout } from './worktree-layout.ts';
import { gitWorktreeRepositoryDirectoryName } from './worktree-names.ts';
import normalizeGitWorktreeRemote, {
  gitRemoteIdentity,
  gitRemoteRepositoryName,
} from './worktree-remote.ts';
import type { GitWorktreeGitResult, GitWorktreeServiceContext } from './worktree-service.ts';

export interface ResolvedRepository {
  path: string;
  refreshBeforeCreate: boolean;
  repositoryId: string;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export async function repositoryPathKind(path: string): Promise<'absent' | 'directory' | 'unsafe'> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return 'unsafe';
    return (await realpath(path)) === path ? 'directory' : 'unsafe';
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
}

function requireGitSuccess(command: string, response: GitWorktreeGitResult): GitWorktreeGitResult {
  if (response.exitCode !== 0) throw new GitCommandError(command, response);
  return response;
}

export class RepositoryPreparationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly identity?: string,
  ) {
    super(code);
  }
}

/** inspect every existing ancestor before creating directories; never repair user permissions. */
export async function ensureRepositoryDirectory(
  path: string,
  create = true,
  privateMode = false,
): Promise<void> {
  const kind = await repositoryPathKind(path);
  if (kind === 'unsafe') throw new RepositoryPreparationError('repository-path-unsafe', path);
  if (kind === 'absent') {
    if (!create) throw new RepositoryPreparationError('repository-path-missing', path);
    const parent = dirname(path);
    if (parent === path) throw new RepositoryPreparationError('repository-path-unsafe', path);
    // ancestors may be system-owned; only newly created and selected directories are owned.
    await ensureRepositoryParent(parent);
    assertPrivateStateLocksHeld();
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    });
  }
  const stats = await lstat(path);
  if (
    (await realpath(path)) !== path ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.getuid && stats.uid !== process.getuid()) ||
    (stats.mode & (privateMode ? 0o077 : 0o022)) !== 0
  ) {
    throw new RepositoryPreparationError('repository-path-unsafe', path);
  }
}

async function ensureRepositoryParent(path: string): Promise<void> {
  const kind = await repositoryPathKind(path);
  if (kind === 'directory') return;
  if (kind === 'unsafe') throw new RepositoryPreparationError('repository-path-unsafe', path);
  await ensureRepositoryDirectory(path);
}

interface RepositoryRecord {
  version: 1;
  repositoryId: string;
  source: string;
  path: string;
  temporaryPath?: string;
}

export interface RepositorySelection {
  path: string;
  source: string;
  kind: 'local' | 'working' | 'bare';
}

/** repository storage is shared; the caller supplies the host's authorized git runner. */
export default class GitRepositoryService {
  readonly #acquireFileLock: typeof acquirePrivateStateFileLock;

  constructor(dependencies: { acquireFileLock?: typeof acquirePrivateStateFileLock } = {}) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquirePrivateStateFileLock;
  }
  async acquire(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    repositoryId: string,
    cloneUrl?: string,
  ): Promise<PrivateStateFileLockHandle> {
    context.signal?.throwIfAborted();
    const localPath = getOwn(layout.localRepositories, repositoryId);
    let targetPath = join(layout.repositoryRoot, gitWorktreeRepositoryDirectoryName(repositoryId));
    if (!localPath && layout.workingDirectory) {
      targetPath = (await this.selection(layout, repositoryId, cloneUrl)).path;
      await ensureRepositoryDirectory(dirname(targetPath));
    }
    if (localPath) {
      const result = requireGitSuccess(
        'common-directory inspection',
        await this.#run(context, localPath, ['rev-parse', '--git-common-dir']),
      );
      if (!result.stdout.trim()) throw new Error('Git returned no shared repository directory.');
      const commonDir = await realpath(resolve(localPath, result.stdout.trim()));
      targetPath = join(commonDir, 'agent-system-worktree-preparation');
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    while (true) {
      context.signal?.throwIfAborted();
      try {
        return await this.#acquireFileLock(targetPath, {
          retries: { factor: 1, maxTimeout: 0, minTimeout: 0, retries: 0 },
          staleMs: 30_000,
        });
      } catch (error) {
        if (nodeErrorCode(error) !== privateStateFileLockBusyErrorCode) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error('Git worktree repository preparation is busy.', { cause: error });
        }
        await abortableDelay(Math.min(250, remaining), context.signal);
      }
    }
  }

  async resolve(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    repositoryId: string,
    cloneUrl?: string,
    reconcileOrigin = false,
    verifyIdentity = false,
  ): Promise<ResolvedRepository> {
    const mapped = getOwn(layout.localRepositories, repositoryId);
    if (mapped && cloneUrl === undefined && !verifyIdentity) {
      return { path: mapped, repositoryId, refreshBeforeCreate: false };
    }
    if (verifyIdentity || layout.workingDirectory) {
      return this.#prepareVerified(context, layout, repositoryId, cloneUrl);
    }
    const localPath = getOwn(layout.localRepositories, repositoryId);
    if (localPath) return { path: localPath, refreshBeforeCreate: false, repositoryId };

    const source = cloneUrl === undefined ? undefined : normalizeGitWorktreeRemote(cloneUrl);
    const path = join(layout.repositoryRoot, gitWorktreeRepositoryDirectoryName(repositoryId));
    const kind = await repositoryPathKind(path);
    if (kind === 'unsafe') throw new Error('The managed Git repository path is unsafe.');
    if (kind === 'directory') {
      const identity = requireGitSuccess(
        'repository identity inspection',
        await this.#run(context, path, ['config', '--get', 'agent-system.repository-id']),
      ).stdout.trim();
      if (identity !== repositoryId) {
        throw new Error('The managed Git repository has another identity.');
      }
      if (source !== undefined) {
        const origin = requireGitSuccess(
          'origin inspection',
          await this.#run(context, path, ['remote', 'get-url', 'origin']),
        ).stdout.trim();
        if (normalizeGitWorktreeRemote(origin) !== source) {
          if (!reconcileOrigin) {
            throw new Error('The managed Git repository uses another origin.');
          }
          await this.#reconcileManagedOrigin(context, path, origin, source);
          return { path, refreshBeforeCreate: false, repositoryId };
        }
      }
      return { path, refreshBeforeCreate: true, repositoryId };
    }
    if (!source) throw new Error('A clone URL is required to create this managed repository.');

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      requireGitSuccess(
        'clone',
        await this.#run(context, layout.repositoryRoot, [
          'clone',
          '--bare',
          '--config',
          'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*',
          '--',
          source,
          temporaryPath,
        ]),
      );
      requireGitSuccess(
        'repository identity',
        await this.#run(context, temporaryPath, [
          'config',
          'agent-system.repository-id',
          repositoryId,
        ]),
      );
      assertPrivateStateLocksHeld();
      await rename(temporaryPath, path);
      return { path, refreshBeforeCreate: false, repositoryId };
    } catch (error) {
      await rm(temporaryPath, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  #recordFile(layout: GitWorktreeLayout, repositoryId: string) {
    return new PrivateStateFile({
      path: join(
        layout.repositoryRoot,
        gitWorktreeRepositoryDirectoryName(repositoryId) + '.repository.json',
      ),
      directories: [layout.repositoryRoot],
      currentUid: process.getuid?.(),
      label: 'repository preparation',
      maximumBytes: 32768,
    });
  }

  async #record(
    layout: GitWorktreeLayout,
    repositoryId: string,
  ): Promise<RepositoryRecord | undefined> {
    const text = await this.#recordFile(layout, repositoryId).read();
    if (text === undefined) return;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('repository-record-invalid');
    const record = value as RepositoryRecord;
    if (
      record.version !== 1 ||
      record.repositoryId !== repositoryId ||
      typeof record.source !== 'string' ||
      typeof record.path !== 'string' ||
      (record.temporaryPath !== undefined &&
        (typeof record.temporaryPath !== 'string' ||
          !record.temporaryPath.startsWith(record.path + '.') ||
          !/^[a-f0-9-]{36}\.tmp$/u.test(record.temporaryPath.slice(record.path.length + 1)))) ||
      Object.keys(value).some(
        (key) => !['version', 'repositoryId', 'source', 'path', 'temporaryPath'].includes(key),
      )
    )
      throw new Error('repository-record-invalid');
    normalizeGitWorktreeRemote(record.source);
    return record;
  }

  async selection(
    layout: GitWorktreeLayout,
    repositoryId: string,
    cloneUrl?: string,
  ): Promise<RepositorySelection> {
    const retained = await this.#record(layout, repositoryId);
    const source = normalizeGitWorktreeRemote(cloneUrl ?? retained?.source ?? '');
    const identity = gitRemoteIdentity(source);
    const local = getOwn(layout.localRepositories, repositoryId);
    const kind = local ? 'local' : layout.workingDirectory ? 'working' : 'bare';
    const path =
      local ??
      (layout.workingDirectory
        ? join(layout.workingDirectory, gitRemoteRepositoryName(source))
        : join(layout.repositoryRoot, gitWorktreeRepositoryDirectoryName(repositoryId)));
    if (retained && (retained.path !== path || gitRemoteIdentity(retained.source) !== identity))
      throw new RepositoryPreparationError(
        'repository-preparation-changed',
        retained.path,
        identity,
      );
    return { path, source, kind };
  }

  async verify(
    context: GitWorktreeServiceContext,
    path: string,
    source: string,
  ): Promise<'bare' | 'working'> {
    await ensureRepositoryDirectory(path, false);
    const identity = gitRemoteIdentity(source);
    const origin = requireGitSuccess(
      'origin inspection',
      await this.#run(context, path, ['remote', 'get-url', 'origin']),
    ).stdout.trim();
    let originIdentity: string | undefined;
    try {
      originIdentity = gitRemoteIdentity(origin);
    } catch {
      // unsupported origins cannot establish the requested provider identity.
    }
    if (originIdentity !== identity)
      throw new RepositoryPreparationError('repository-identity-conflict', path, identity);
    const bare = requireGitSuccess(
      'repository identity inspection',
      await this.#run(context, path, ['rev-parse', '--is-bare-repository']),
    ).stdout.trim();
    if (bare === 'true') return 'bare';
    if (
      bare !== 'false' ||
      requireGitSuccess(
        'repository identity inspection',
        await this.#run(context, path, ['rev-parse', '--show-toplevel']),
      ).stdout.trim() !== path
    )
      throw new RepositoryPreparationError('repository-path-conflict', path, identity);
    return 'working';
  }

  async #prepareVerified(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    repositoryId: string,
    cloneUrl?: string,
  ): Promise<ResolvedRepository> {
    const selected = await this.selection(layout, repositoryId, cloneUrl);
    const { path, source, kind } = selected;
    const state = this.#recordFile(layout, repositoryId);
    const retained = await this.#record(layout, repositoryId);
    const exists = await repositoryPathKind(path);
    if (exists !== 'absent') {
      const form = await this.verify(context, path, source);
      if ((kind === 'working' && form !== 'working') || (kind === 'bare' && form !== 'bare'))
        throw new RepositoryPreparationError(
          'repository-path-conflict',
          path,
          gitRemoteIdentity(source),
        );
      if (
        retained?.temporaryPath &&
        (await repositoryPathKind(retained.temporaryPath)) !== 'absent'
      )
        throw new RepositoryPreparationError(
          'repository-clone-interrupted',
          retained.temporaryPath,
        );
      if (kind !== 'local')
        await state.write(JSON.stringify({ version: 1, repositoryId, source, path }));
      return { path, repositoryId, refreshBeforeCreate: kind !== 'local' };
    }
    if (kind === 'local') throw new RepositoryPreparationError('repository-path-missing', path);
    await ensureRepositoryDirectory(dirname(path));
    const temporaryPath = retained?.temporaryPath ?? `${path}.${randomUUID()}.tmp`;
    await state.write(JSON.stringify({ version: 1, repositoryId, source, path, temporaryPath }));
    if ((await repositoryPathKind(temporaryPath)) !== 'absent') {
      // after interruption, only a fully verified clone can advance; partial clones need an operator.
      try {
        const form = await this.verify(context, temporaryPath, source);
        if ((kind === 'bare') !== (form === 'bare')) throw new Error('clone-form');
        requireGitSuccess(
          'base-ref validation',
          await this.#run(context, temporaryPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
        );
      } catch {
        throw new RepositoryPreparationError(
          'repository-clone-interrupted',
          temporaryPath,
          gitRemoteIdentity(source),
        );
      }
    } else {
      try {
        requireGitSuccess(
          'clone',
          await this.#run(context, dirname(path), [
            'clone',
            ...(kind === 'bare'
              ? ['--bare', '--config', 'remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*']
              : []),
            '--',
            source,
            temporaryPath,
          ]),
        );
        const form = await this.verify(context, temporaryPath, source);
        if ((kind === 'bare') !== (form === 'bare'))
          throw new RepositoryPreparationError(
            'repository-path-conflict',
            temporaryPath,
            gitRemoteIdentity(source),
          );
      } catch (error) {
        assertPrivateStateLocksHeld();
        await rm(temporaryPath, { recursive: true, force: true });
        await state.write(JSON.stringify({ version: 1, repositoryId, source, path }));
        throw error;
      }
    }
    if (kind === 'bare')
      requireGitSuccess(
        'repository identity',
        await this.#run(context, temporaryPath, [
          'config',
          'agent-system.repository-id',
          repositoryId,
        ]),
      );
    assertPrivateStateLocksHeld();
    if ((await repositoryPathKind(path)) !== 'absent')
      throw new RepositoryPreparationError('repository-path-conflict', path);
    await rename(temporaryPath, path);
    await this.verify(context, path, source);
    await state.write(JSON.stringify({ version: 1, repositoryId, source, path }));
    return { path, repositoryId, refreshBeforeCreate: false };
  }

  async workingRepositories(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    repositoryId?: string,
  ): Promise<ResolvedRepository[]> {
    if (!layout.workingDirectory) return [];
    const records = (await readdir(layout.repositoryRoot)).filter((name) =>
      repositoryId === undefined
        ? name.endsWith('.repository.json')
        : name === gitWorktreeRepositoryDirectoryName(repositoryId) + '.repository.json',
    );
    const result: ResolvedRepository[] = [];
    for (const name of records) {
      const file = new PrivateStateFile({
        path: join(layout.repositoryRoot, name),
        directories: [layout.repositoryRoot],
        currentUid: process.getuid?.(),
        label: 'repository preparation',
        maximumBytes: 32768,
      });
      const value: unknown = JSON.parse((await file.read()) ?? 'null');
      if (
        !value ||
        typeof value !== 'object' ||
        !('repositoryId' in value) ||
        typeof value.repositoryId !== 'string'
      )
        throw new Error('repository-record-invalid');
      const id = value.repositoryId;
      if (name !== gitWorktreeRepositoryDirectoryName(id) + '.repository.json')
        throw new Error('repository-record-invalid');
      const selected = await this.selection(layout, id);
      if (selected.kind !== 'working' || (await repositoryPathKind(selected.path)) === 'absent')
        continue;
      await this.verify(context, selected.path, selected.source);
      result.push({ path: selected.path, repositoryId: id, refreshBeforeCreate: true });
    }
    return result;
  }

  async #reconcileManagedOrigin(
    context: GitWorktreeServiceContext,
    path: string,
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<void> {
    const previous = normalizeGitWorktreeRemote(currentOrigin);
    requireGitSuccess(
      'origin reconciliation',
      await this.#run(context, path, ['remote', 'set-url', 'origin', nextOrigin]),
    );
    try {
      const verified = requireGitSuccess(
        'origin reconciliation verification',
        await this.#run(context, path, ['remote', 'get-url', 'origin']),
      ).stdout.trim();
      if (normalizeGitWorktreeRemote(verified) !== nextOrigin) {
        throw new Error('Git retained an unexpected managed repository origin.');
      }
      requireGitSuccess(
        'origin reconciliation fetch',
        await this.#run(context, path, ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']),
      );
    } catch (error) {
      const rollback = await this.#run(context, path, ['remote', 'set-url', 'origin', previous]);
      if (rollback.exitCode !== 0) {
        throw new Error('The managed Git repository origin could not be restored.', {
          cause: error,
        });
      }
      throw new Error('The managed Git repository origin could not be reconciled.', {
        cause: error,
      });
    }
  }

  async #run(context: GitWorktreeServiceContext, cwd: string, argv: string[]) {
    assertPrivateStateLocksHeld();
    const result = await context.git.run({
      argv,
      cwd,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    assertPrivateStateLocksHeld();
    return result;
  }
}
