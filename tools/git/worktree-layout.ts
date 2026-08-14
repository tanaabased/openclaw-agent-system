import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

import isPathContained from '../../utils/is-path-contained.ts';
import type { GitWorktreeConfiguration } from './config-schema.ts';

export const defaultGitRepositoryRoot = '.agent-system/repositories';
export const defaultGitWorktreeRoot = '.agent-system/worktrees';

export interface GitWorktreeLayout {
  ignoreEntries: string[];
  localRepositories: Record<string, string>;
  repositoryRoot: string;
  worktreeRoot: string;
  workspaceDir: string;
}

function resolveConfiguredPath(input: string, workspaceDir: string, homeDirectory: string): string {
  if (input === '~') return resolve(homeDirectory);
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) {
    return resolve(homeDirectory, input.slice(2));
  }
  if (input.startsWith('~')) throw new Error('Git worktree paths may not use another user home.');
  return resolve(workspaceDir, input);
}

function ignoreEntry(workspaceDir: string, path: string): string | undefined {
  if (!isPathContained(workspaceDir, path) || path === workspaceDir) return undefined;
  const workspacePath = relative(workspaceDir, path)
    .split(sep)
    .join('/')
    .replace(/([\\*?[\]])/gu, '\\$1')
    .replace(/^([#!])/u, '\\$1');
  return `/${workspacePath}/`;
}

/** Resolve manifest worktree paths without reading or mutating the filesystem. */
export default function resolveGitWorktreeLayout(
  workspaceDir: string,
  configuration: GitWorktreeConfiguration,
  homeDirectory = homedir(),
): GitWorktreeLayout {
  const workspace = resolve(workspaceDir);
  const worktreeRoot = resolveConfiguredPath(
    configuration.root ?? defaultGitWorktreeRoot,
    workspace,
    homeDirectory,
  );
  const repositoryRoot = resolveConfiguredPath(
    configuration.repositories?.root ?? defaultGitRepositoryRoot,
    workspace,
    homeDirectory,
  );
  if (
    worktreeRoot === repositoryRoot ||
    isPathContained(worktreeRoot, repositoryRoot) ||
    isPathContained(repositoryRoot, worktreeRoot)
  ) {
    throw new Error('Git worktree and repository roots must be separate directories.');
  }

  const localRepositories = Object.fromEntries(
    Object.entries(configuration.repositories?.local ?? {}).map(([id, path]) => [
      id,
      resolveConfiguredPath(path, workspace, homeDirectory),
    ]),
  );
  if (
    Object.values(localRepositories).some(
      (path) => isPathContained(repositoryRoot, path) || isPathContained(worktreeRoot, path),
    )
  ) {
    throw new Error('Git local repository overrides may not be inside managed roots.');
  }
  const ignoreEntries = [
    ignoreEntry(workspace, repositoryRoot),
    ignoreEntry(workspace, worktreeRoot),
  ].filter((entry): entry is string => entry !== undefined);

  return {
    ignoreEntries,
    localRepositories,
    repositoryRoot,
    worktreeRoot,
    workspaceDir: workspace,
  };
}
