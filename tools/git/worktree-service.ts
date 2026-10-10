import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertPrivateStateLocksHeld,
  withPrivateStateLock,
  privateStateLockSignal,
} from '../../core/private-state-lock-context.ts';
import type acquirePrivateStateFileLock from '../../core/private-state-file-lock.ts';
import isPathContained from '../../utils/is-path-contained.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import GitCommandError from './command-error.ts';
import GitRepositoryService, { type ResolvedRepository } from './repository-service.ts';
import type { GitWorktreeConfiguration } from './config-schema.ts';
import type GitWorktreeLayoutService from './worktree-layout-service.ts';
import type { GitWorktreeLayout } from './worktree-layout.ts';
import {
  gitHubIssueBranchName,
  gitWorktreeDirectoryName,
  gitWorktreeRepositoryDirectoryName,
  isGitHubIssueBranchName,
} from './worktree-names.ts';
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
  issueBranch?: { number: number; suffix: string; title: string };
  reconcileOrigin?: boolean;
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

export interface GitWorktreeCleanupResult {
  branch: string;
  path: string;
  repositoryId: string;
  status: 'dirty' | 'failed' | 'missing' | 'removed' | 'unsafe';
  workId: string;
}

interface RegisteredWorktree {
  branch: string;
  path: string;
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
    if (nodeErrorCode(error) === 'ENOENT') return 'absent';
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
  if (response.exitCode !== 0) throw new GitCommandError(command, response);
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
  readonly #repositoryService: GitRepositoryService;
  readonly #layoutService: Pick<GitWorktreeLayoutService, 'inspect'>;

  constructor(dependencies: {
    acquireFileLock?: typeof acquirePrivateStateFileLock;
    layoutService: Pick<GitWorktreeLayoutService, 'inspect'>;
  }) {
    this.#repositoryService = new GitRepositoryService(dependencies);
    this.#layoutService = dependencies.layoutService;
  }

  async prepare(
    context: GitWorktreeServiceContext,
    input: GitWorktreePrepareInput,
  ): Promise<GitWorktreeResult> {
    this.#validatePrepareInput(input);
    const layout = await this.#readyLayout(context);
    const lease = await this.#repositoryService.acquire(
      context,
      layout,
      input.repositoryId,
      input.cloneUrl,
    );
    try {
      context.signal?.throwIfAborted();
      return await withPrivateStateLock(lease, () =>
        this.#prepare(
          { ...context, signal: privateStateLockSignal(context.signal) },
          input,
          layout,
        ),
      );
    } finally {
      await lease.release();
    }
  }

  async #prepare(
    context: GitWorktreeServiceContext,
    input: GitWorktreePrepareInput,
    layout: GitWorktreeLayout,
  ): Promise<GitWorktreeResult> {
    const repository = await this.#repositoryService.resolve(
      context,
      layout,
      input.repositoryId,
      input.cloneUrl,
      input.reconcileOrigin ?? false,
    );
    const stableName = gitWorktreeDirectoryName(input.repositoryId, input.workId);
    const branch = input.issueBranch
      ? gitHubIssueBranchName(
          input.issueBranch.number,
          input.issueBranch.title,
          input.issueBranch.suffix,
        )
      : stableName;
    const path = this.#worktreePath(layout, input.repositoryId, stableName);
    const registered = await this.#registeredWorktrees(context, repository);
    const existing = registered.find((worktree) => worktree.path === path);
    if (existing) {
      if (
        existing.branch !== stableName &&
        (!input.issueBranch ||
          !isGitHubIssueBranchName(
            existing.branch,
            input.issueBranch.number,
            input.issueBranch.suffix,
          ))
      ) {
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
    if (branchExists && input.issueBranch) {
      throw new Error(
        'The readable GitHub issue branch already exists outside its owned worktree.',
      );
    }
    assertPrivateStateLocksHeld();
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
    const repository = await this.#repositoryService.resolve(context, layout, repositoryId);
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

  async cleanup(
    context: GitWorktreeServiceContext,
    repositoryId: string,
    workId: string,
    expectedBranch?: string,
  ): Promise<GitWorktreeCleanupResult> {
    validateIdentifier(repositoryId, 'repository id');
    validateIdentifier(workId, 'work id');
    const layout = await this.#readyLayout(context);
    if (expectedBranch !== undefined) validateIdentifier(expectedBranch, 'expected branch');
    const stableName = gitWorktreeDirectoryName(repositoryId, workId);
    const branch = expectedBranch ?? stableName;
    const path = this.#worktreePath(layout, repositoryId, stableName);
    const base = { branch, path, repositoryId, workId };
    const repository = await this.#repositoryService.resolve(context, layout, repositoryId);
    const existing = (await this.#registeredWorktrees(context, repository)).find(
      (worktree) => worktree.path === path,
    );
    const kind = await pathKind(path);
    if (!existing) return { ...base, status: kind === 'absent' ? 'missing' : 'unsafe' };
    if (
      existing.branch !== branch ||
      kind !== 'directory' ||
      !isPathContained(layout.worktreeRoot, path)
    ) {
      return { ...base, status: 'unsafe' };
    }
    const status = await this.#run(context, path, [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (status.exitCode !== 0) return { ...base, status: 'failed' };
    if (status.stdout.trim()) return { ...base, status: 'dirty' };
    const removed = await this.#run(context, repository.path, ['worktree', 'remove', path]);
    return { ...base, status: removed.exitCode === 0 ? 'removed' : 'failed' };
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
    if (
      input.issueBranch &&
      (!Number.isSafeInteger(input.issueBranch.number) ||
        input.issueBranch.number < 1 ||
        !/^[a-f0-9]{5}$/u.test(input.issueBranch.suffix))
    ) {
      throw new Error('The GitHub issue branch identity is invalid.');
    }
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
      (inspection.workingDirectory !== undefined && inspection.workingDirectory !== 'ready') ||
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
      if (layout.workingDirectory) {
        return this.#repositoryService.workingRepositories(context, layout, selectedId);
      }
      const managedPath = join(
        layout.repositoryRoot,
        gitWorktreeRepositoryDirectoryName(selectedId),
      );
      if ((await pathKind(managedPath)) === 'absent') return [];
      return [await this.#repositoryService.resolve(context, layout, selectedId)];
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
    const working = await this.#repositoryService.workingRepositories(context, layout);
    return [
      ...local,
      ...working,
      ...managed.filter((value): value is ResolvedRepository => Boolean(value)),
    ];
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
