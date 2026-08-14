import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import isPathContained from '../../utils/is-path-contained.ts';
import type { GitWorktreeConfiguration } from './config-schema.ts';
import type GitWorktreeLayoutService from './worktree-layout-service.ts';
import type { GitWorktreeLayout } from './worktree-layout.ts';
import { gitWorktreeDirectoryName, gitWorktreeRepositoryDirectoryName } from './worktree-names.ts';
import normalizeGitWorktreeRemote from './worktree-remote.ts';

export interface GitWorktreeGitResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export interface GitWorktreeGitRunner {
  run(input: { argv: string[]; cwd: string; signal?: AbortSignal }): Promise<GitWorktreeGitResult>;
}

export interface GitWorktreeServiceContext {
  configuration: GitWorktreeConfiguration;
  git: GitWorktreeGitRunner;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitWorktreePrepareInput {
  baseRef: string;
  cloneUrl?: string;
  repositoryId: string;
  workId: string;
}

export interface GitWorktreeResult {
  branch: string;
  path: string;
  repositoryId: string;
  status: 'active' | 'created' | 'existing' | 'removed';
  workId?: string;
}

interface ResolvedRepository {
  path: string;
  refreshBeforeCreate: boolean;
  repositoryId: string;
}

interface RegisteredWorktree {
  branch: string;
  path: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

async function pathKind(path: string): Promise<'absent' | 'directory' | 'unsafe'> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return 'unsafe';
    return (await realpath(path)) === path ? 'directory' : 'unsafe';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
}

function validateIdentifier(value: string, label: string): void {
  const hasControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  if (
    !value ||
    value.length > 256 ||
    value !== value.trim() ||
    value.startsWith('-') ||
    hasControl
  ) {
    throw new Error(`The Git worktree ${label} is invalid.`);
  }
}

function requireGitSuccess(command: string, response: GitWorktreeGitResult): GitWorktreeGitResult {
  if (response.exitCode !== 0) throw new Error(`Git ${command} failed.`);
  return response;
}

function parseWorktrees(source: string): RegisteredWorktree[] {
  return source
    .trim()
    .split(/\r?\n\r?\n/u)
    .flatMap((block) => {
      const lines = block.split(/\r?\n/u);
      if (lines.includes('bare')) return [];
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const branch = lines
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length);
      return path && branch ? [{ branch, path }] : [];
    });
}

/** Prepare, discover, and remove deterministic worktrees while leaving state to Git. */
export default class GitWorktreeService {
  readonly #layoutService: Pick<GitWorktreeLayoutService, 'inspect'>;

  constructor(dependencies: { layoutService: Pick<GitWorktreeLayoutService, 'inspect'> }) {
    this.#layoutService = dependencies.layoutService;
  }

  async prepare(
    context: GitWorktreeServiceContext,
    input: GitWorktreePrepareInput,
  ): Promise<GitWorktreeResult> {
    this.#validatePrepareInput(input);
    const layout = await this.#readyLayout(context);
    const repository = await this.#resolveRepository(
      context,
      layout,
      input.repositoryId,
      input.cloneUrl,
    );
    const branch = gitWorktreeDirectoryName(input.repositoryId, input.workId);
    const path = this.#worktreePath(layout, input.repositoryId, branch);
    const registered = await this.#registeredWorktrees(context, repository);
    const existing = registered.find((worktree) => worktree.path === path);
    if (existing) {
      if (existing.branch !== branch) {
        throw new Error('The deterministic Git worktree path uses another branch.');
      }
      return this.#result(input.repositoryId, input.workId, existing, 'existing');
    }
    if ((await pathKind(path)) !== 'absent') {
      throw new Error('The deterministic Git worktree path is already occupied.');
    }
    if (repository.refreshBeforeCreate) {
      requireGitSuccess(
        'fetch',
        await this.#run(context, repository.path, [
          'fetch',
          'origin',
          '+refs/heads/*:refs/remotes/origin/*',
        ]),
      );
    }

    requireGitSuccess(
      'branch validation',
      await this.#run(context, repository.path, ['check-ref-format', '--branch', branch]),
    );
    requireGitSuccess(
      'base-ref validation',
      await this.#run(context, repository.path, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${input.baseRef}^{commit}`,
      ]),
    );
    const branchExists =
      (
        await this.#run(context, repository.path, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ])
      ).exitCode === 0;
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    requireGitSuccess(
      'worktree preparation',
      await this.#run(context, repository.path, [
        'worktree',
        'add',
        ...(branchExists ? [] : ['-b', branch]),
        path,
        branchExists ? branch : input.baseRef,
      ]),
    );
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path || !isPathContained(layout.worktreeRoot, canonicalPath)) {
      throw new Error('Git prepared an unexpected worktree path.');
    }
    return this.#result(
      input.repositoryId,
      input.workId,
      { branch, path: canonicalPath },
      'created',
    );
  }

  async list(
    context: GitWorktreeServiceContext,
    repositoryId?: string,
  ): Promise<GitWorktreeResult[]> {
    if (repositoryId !== undefined) validateIdentifier(repositoryId, 'repository id');
    const layout = await this.#readyLayout(context);
    const repositories = await this.#repositories(context, layout, repositoryId);
    const worktrees = await Promise.all(
      repositories.map(async (repository) =>
        (await this.#registeredWorktrees(context, repository))
          .filter((worktree) => isPathContained(layout.worktreeRoot, worktree.path))
          .map((worktree) => ({
            branch: worktree.branch,
            path: worktree.path,
            repositoryId: repository.repositoryId,
            status: 'active' as const,
          })),
      ),
    );
    return worktrees.flat().sort((left, right) => left.path.localeCompare(right.path));
  }

  async remove(
    context: GitWorktreeServiceContext,
    repositoryId: string,
    workId: string,
  ): Promise<GitWorktreeResult> {
    validateIdentifier(repositoryId, 'repository id');
    validateIdentifier(workId, 'work id');
    const layout = await this.#readyLayout(context);
    const repository = await this.#resolveRepository(context, layout, repositoryId);
    const path = this.#worktreePath(
      layout,
      repositoryId,
      gitWorktreeDirectoryName(repositoryId, workId),
    );
    const existing = (await this.#registeredWorktrees(context, repository)).find(
      (worktree) => worktree.path === path,
    );
    if (!existing) throw new Error('The deterministic Git worktree is unavailable.');
    requireGitSuccess(
      'worktree removal',
      await this.#run(context, repository.path, ['worktree', 'remove', path]),
    );
    return this.#result(repositoryId, workId, existing, 'removed');
  }

  #result(
    repositoryId: string,
    workId: string,
    worktree: RegisteredWorktree,
    status: GitWorktreeResult['status'],
  ): GitWorktreeResult {
    return {
      branch: worktree.branch,
      path: worktree.path,
      repositoryId,
      status,
      workId,
    };
  }

  #validatePrepareInput(input: GitWorktreePrepareInput): void {
    validateIdentifier(input.repositoryId, 'repository id');
    validateIdentifier(input.workId, 'work id');
    validateIdentifier(input.baseRef, 'base ref');
    if (input.cloneUrl !== undefined) normalizeGitWorktreeRemote(input.cloneUrl);
  }

  #worktreePath(layout: GitWorktreeLayout, repositoryId: string, name: string): string {
    return join(
      layout.worktreeRoot,
      gitWorktreeRepositoryDirectoryName(repositoryId).replace(/\.git$/u, ''),
      name,
    );
  }

  async #readyLayout(context: GitWorktreeServiceContext): Promise<GitWorktreeLayout> {
    const inspection = await this.#layoutService.inspect(
      context.workspaceDir,
      context.configuration,
    );
    if (
      inspection.repositoryRoot !== 'ready' ||
      inspection.worktreeRoot !== 'ready' ||
      !inspection.gitignored ||
      Object.values(inspection.localRepositories).some((status) => status !== 'ready')
    ) {
      throw new Error('Git worktree roots are not installed.');
    }
    return inspection.layout;
  }

  async #repositories(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    selectedId?: string,
  ): Promise<ResolvedRepository[]> {
    if (selectedId !== undefined) {
      const localPath = getOwn(layout.localRepositories, selectedId);
      if (localPath) {
        return [{ path: localPath, refreshBeforeCreate: false, repositoryId: selectedId }];
      }
      const managedPath = join(
        layout.repositoryRoot,
        gitWorktreeRepositoryDirectoryName(selectedId),
      );
      if ((await pathKind(managedPath)) === 'absent') return [];
      return [await this.#resolveRepository(context, layout, selectedId)];
    }
    const local = Object.entries(layout.localRepositories).map(([repositoryId, path]) => ({
      path,
      refreshBeforeCreate: false,
      repositoryId,
    }));
    const managed = await Promise.all(
      (await readdir(layout.repositoryRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'))
        .map(async (entry): Promise<ResolvedRepository | undefined> => {
          const path = join(layout.repositoryRoot, entry.name);
          const id = await this.#run(context, path, [
            'config',
            '--get',
            'agent-system.repository-id',
          ]);
          const repositoryId = id.exitCode === 0 ? id.stdout.trim() : '';
          return repositoryId ? { path, refreshBeforeCreate: true, repositoryId } : undefined;
        }),
    );
    return [...local, ...managed.filter((value): value is ResolvedRepository => Boolean(value))];
  }

  async #resolveRepository(
    context: GitWorktreeServiceContext,
    layout: GitWorktreeLayout,
    repositoryId: string,
    cloneUrl?: string,
  ): Promise<ResolvedRepository> {
    const localPath = getOwn(layout.localRepositories, repositoryId);
    if (localPath) return { path: localPath, refreshBeforeCreate: false, repositoryId };

    const source = cloneUrl === undefined ? undefined : normalizeGitWorktreeRemote(cloneUrl);
    const path = join(layout.repositoryRoot, gitWorktreeRepositoryDirectoryName(repositoryId));
    const kind = await pathKind(path);
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
          throw new Error('The managed Git repository uses another origin.');
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
      await rename(temporaryPath, path);
      return { path, refreshBeforeCreate: false, repositoryId };
    } catch (error) {
      await rm(temporaryPath, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async #registeredWorktrees(
    context: GitWorktreeServiceContext,
    repository: ResolvedRepository,
  ): Promise<RegisteredWorktree[]> {
    return parseWorktrees(
      requireGitSuccess(
        'worktree inspection',
        await this.#run(context, repository.path, ['worktree', 'list', '--porcelain']),
      ).stdout,
    );
  }

  #run(context: GitWorktreeServiceContext, cwd: string, argv: string[]) {
    return context.git.run({
      argv,
      cwd,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }
}
