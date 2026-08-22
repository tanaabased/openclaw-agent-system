import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import runToolCli from '../../api/cli-runner.ts';
import WorkspaceGitignoreService from '../../paths/workspace-gitignore-service.ts';
import isPathContained from '../../utils/is-path-contained.ts';
import type { GitWorktreeConfiguration } from './config-schema.ts';
import resolveGitWorktreeLayout, { type GitWorktreeLayout } from './worktree-layout.ts';

export type GitManagedDirectoryStatus = 'missing' | 'ready' | 'unsafe';

export interface GitWorktreeLayoutInspection {
  gitignored: boolean;
  layout: GitWorktreeLayout;
  localRepositories: Record<string, GitManagedDirectoryStatus>;
  repositoryRoot: GitManagedDirectoryStatus;
  tracked: boolean;
  worktreeRoot: GitManagedDirectoryStatus;
}

export interface GitWorktreeLayoutReconcileResult extends GitWorktreeLayoutInspection {
  actions: Array<'create-repository-root' | 'create-worktree-root' | 'update-gitignore'>;
}

export interface GitWorktreeLayoutServiceDependencies {
  baseEnvironment?: Readonly<NodeJS.ProcessEnv>;
  currentUid?: number;
  excludedExecutableDirectories?: readonly string[];
  gitignoreService?: Pick<WorkspaceGitignoreService, 'includes' | 'reconcile'>;
  homeDirectory?: string;
  runCli?: typeof runToolCli;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function directoryStatus(
  path: string,
  currentUid?: number,
  ownerOnly = false,
): Promise<GitManagedDirectoryStatus> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return 'unsafe';
    if (currentUid !== undefined && stats.uid !== currentUid) return 'unsafe';
    if ((stats.mode & (ownerOnly ? 0o077 : 0o022)) !== 0) return 'unsafe';
    return (await realpath(path)) === path ? 'ready' : 'unsafe';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
}

function workspaceManagedPaths(workspaceDir: string, layout: GitWorktreeLayout): string[] {
  return [layout.repositoryRoot, layout.worktreeRoot]
    .filter((path) => path !== workspaceDir && isPathContained(workspaceDir, path))
    .map((path) => relative(workspaceDir, path));
}

/** Inspect and reconcile workspace-owned repository and worktree roots. */
export default class GitWorktreeLayoutService {
  readonly #currentUid: number | undefined;
  readonly #baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly #excludedExecutableDirectories: readonly string[];
  readonly #gitignoreService: Pick<WorkspaceGitignoreService, 'includes' | 'reconcile'>;
  readonly #homeDirectory: string | undefined;
  readonly #runCli: typeof runToolCli;

  constructor(dependencies: GitWorktreeLayoutServiceDependencies = {}) {
    this.#baseEnvironment = dependencies.baseEnvironment ?? process.env;
    this.#currentUid = dependencies.currentUid;
    this.#excludedExecutableDirectories = dependencies.excludedExecutableDirectories ?? [];
    this.#gitignoreService = dependencies.gitignoreService ?? new WorkspaceGitignoreService();
    this.#homeDirectory = dependencies.homeDirectory;
    this.#runCli = dependencies.runCli ?? runToolCli;
  }

  async inspect(
    workspaceDir: string,
    configuration: GitWorktreeConfiguration,
  ): Promise<GitWorktreeLayoutInspection> {
    const workspace = await realpath(workspaceDir);
    const layout = resolveGitWorktreeLayout(workspace, configuration, this.#homeDirectory);
    const localRepositories = Object.fromEntries(
      await Promise.all(
        Object.entries(layout.localRepositories).map(async ([id, path]) => [
          id,
          await this.#localRepositoryStatus(path),
        ]),
      ),
    );
    const declaredIgnored = await this.#gitignoreService.includes(workspace, layout.ignoreEntries);
    const gitPaths = await this.#inspectGitPaths(workspace, layout);
    return {
      gitignored: declaredIgnored && gitPaths.ignored,
      layout,
      localRepositories,
      repositoryRoot: await directoryStatus(layout.repositoryRoot, this.#currentUid, true),
      tracked: gitPaths.tracked,
      worktreeRoot: await directoryStatus(layout.worktreeRoot, this.#currentUid, true),
    };
  }

  async reconcile(
    workspaceDir: string,
    configuration: GitWorktreeConfiguration,
  ): Promise<GitWorktreeLayoutReconcileResult> {
    const workspace = await realpath(workspaceDir);
    const layout = resolveGitWorktreeLayout(workspace, configuration, this.#homeDirectory);
    const actions: GitWorktreeLayoutReconcileResult['actions'] = [];
    const initialGitPaths = await this.#inspectGitPaths(workspace, layout);
    if (!initialGitPaths.verifiable) {
      throw new Error('Git worktree managed paths could not be inspected safely.');
    }
    if (initialGitPaths.tracked) {
      throw new Error('Git worktree managed roots contain tracked workspace paths.');
    }
    const beforeRepository = await directoryStatus(layout.repositoryRoot, this.#currentUid, true);
    const beforeWorktree = await directoryStatus(layout.worktreeRoot, this.#currentUid, true);
    if (beforeRepository === 'unsafe' || beforeWorktree === 'unsafe') {
      throw new Error('Git worktree managed roots are unavailable or unsafe.');
    }
    const localRepositories = await Promise.all(
      Object.values(layout.localRepositories).map((path) => this.#localRepositoryStatus(path)),
    );
    if (localRepositories.some((status) => status !== 'ready')) {
      throw new Error('Git worktree local repository overrides are unavailable or unsafe.');
    }
    if (
      layout.ignoreEntries.length > 0 &&
      (await this.#gitignoreService.reconcile(workspace, {
        comment: '# Agent System managed Git workspaces.',
        entries: layout.ignoreEntries,
      }))
    ) {
      actions.push('update-gitignore');
    }

    if (beforeRepository === 'missing') {
      await mkdir(layout.repositoryRoot, { mode: 0o700, recursive: true });
      await chmod(layout.repositoryRoot, 0o700);
      actions.push('create-repository-root');
    }
    if (beforeWorktree === 'missing') {
      await mkdir(layout.worktreeRoot, { mode: 0o700, recursive: true });
      await chmod(layout.worktreeRoot, 0o700);
      actions.push('create-worktree-root');
    }

    const inspection = await this.inspect(workspace, configuration);
    if (
      inspection.repositoryRoot !== 'ready' ||
      inspection.worktreeRoot !== 'ready' ||
      !inspection.gitignored ||
      inspection.tracked ||
      Object.values(inspection.localRepositories).some((status) => status !== 'ready')
    ) {
      throw new Error('Git worktree layout did not match the manifest after installation.');
    }
    return { ...inspection, actions };
  }

  async #inspectGitPaths(
    workspaceDir: string,
    layout: GitWorktreeLayout,
  ): Promise<{ ignored: boolean; tracked: boolean; verifiable: boolean }> {
    const paths = workspaceManagedPaths(workspaceDir, layout);
    if (paths.length === 0) return { ignored: true, tracked: false, verifiable: true };
    const repository = await this.#runGit(['rev-parse', '--show-toplevel'], workspaceDir);
    if (!repository) return { ignored: false, tracked: false, verifiable: false };
    if (repository.exitCode !== 0) return { ignored: true, tracked: false, verifiable: true };
    const ignored = await Promise.all(
      paths.map(async (path) => {
        const result = await this.#runGit(
          ['check-ignore', '--quiet', '--no-index', '--', path],
          workspaceDir,
        );
        return result ? result.exitCode === 0 : undefined;
      }),
    );
    const tracked = await this.#runGit(
      ['ls-files', '--error-unmatch', '--', ...paths],
      workspaceDir,
    );
    return {
      ignored: ignored.every((value) => value === true),
      tracked: tracked?.exitCode === 0,
      verifiable: tracked !== undefined && ignored.every((value) => value !== undefined),
    };
  }

  async #localRepositoryStatus(path: string): Promise<GitManagedDirectoryStatus> {
    const status = await directoryStatus(path, this.#currentUid);
    if (status !== 'ready') return status;
    const result = await this.#runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      path,
    );
    return result?.exitCode === 0 ? 'ready' : 'unsafe';
  }

  async #runGit(argv: string[], cwd: string) {
    try {
      return await this.#runCli({
        argv,
        cwd,
        environment: {
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          PATH: this.#baseEnvironment.PATH,
        },
        executable: 'git',
        excludedExecutableDirectories: [...this.#excludedExecutableDirectories],
        maxOutputBytes: 65_536,
        timeoutMs: 30_000,
      });
    } catch {
      return undefined;
    }
  }
}
