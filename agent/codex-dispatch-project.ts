import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { nativeObject } from './automation-gateway.ts';
import type { DispatchProject } from './codex-dispatch-state.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import {
  ensureRepositoryDirectory,
  RepositoryPreparationError,
} from '../tools/git/repository-service.ts';
import { gitRemoteIdentity } from '../tools/git/worktree-remote.ts';
import { resolveToolExecutable } from '../api/cli-runner.ts';
import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';

export type DispatchGit = (cwd: string, argv: string[], signal?: AbortSignal) => Promise<string>;

export const dispatchGit: DispatchGit = async (cwd, argv, signal) => {
  const executable = await resolveToolExecutable('git', process.env.PATH ?? '');
  const result = await runCodexSetupProcess([executable, ...argv], {
    cwd,
    baseEnv: process.env,
    env: { GIT_TERMINAL_PROMPT: '0' },
    input: '',
    ...(signal ? { signal } : {}),
    timeoutMs: 60000,
    maxOutputBytes: 65536,
    maxCombinedOutputBytes: 131072,
    killGraceMs: 1000,
    killProcessTree: true,
    outputCapture: 'head',
  });
  if (result.code !== 0 || result.termination !== 'exit' || result.stdoutTruncatedBytes) {
    const authentication =
      /authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey\)/iu.test(
        result.stderr,
      );
    throw new Error(
      authentication ? 'dispatch-project-git-auth-unavailable' : 'dispatch-project-git-unavailable',
    );
  }
  return result.stdout.trim();
};

export function githubOrigin(value: string): string | undefined {
  try {
    const identity = gitRemoteIdentity(value);
    return identity.startsWith('github.com/') && identity.split('/').length === 3
      ? identity.slice('github.com/'.length)
      : undefined;
  } catch {
    return undefined;
  }
}

/** verify one saved project's primary checkout; repository preparation remains a separate step. */
export async function resolveDispatchProject(
  input: {
    projects: unknown;
    repository: string;
    defaultBranch: string;
    workspace: string;
    explicitPath?: string;
  },
  git: DispatchGit = dispatchGit,
): Promise<DispatchProject> {
  if (!Array.isArray(input.projects) || input.projects.length > 1000)
    throw new Error('dispatch-project-inventory-invalid');
  const configured = input.explicitPath;
  const expectedPath =
    configured === undefined
      ? undefined
      : resolve(
          configured.startsWith('~/') ? homedir() : input.workspace,
          configured.startsWith('~/') ? configured.slice(2) : configured,
        );
  const expected =
    expectedPath === undefined
      ? undefined
      : await realpath(expectedPath).catch((error: unknown) => {
          if (isFilesystemAccessError(error)) throw error;
          throw new Error('dispatch-configured-project-missing', { cause: error });
        });
  if (expected !== expectedPath) throw new Error('dispatch-project-path-unsafe');
  const matches: { id: string; path: string }[] = [];
  for (const project of input.projects) {
    if (
      !nativeObject(project) ||
      project.projectKind !== 'local' ||
      project.hostId !== 'local' ||
      project.isGitRepository !== true ||
      typeof project.path !== 'string' ||
      typeof project.projectId !== 'string'
    )
      continue;
    if (expected && project.path !== expected) continue;
    const path = await realpath(project.path).catch((error: unknown) => {
      if (isFilesystemAccessError(error)) throw error;
      return undefined;
    });
    if (!path) continue;
    if (path !== project.path) throw new Error('dispatch-project-path-unsafe');
    await ensureRepositoryDirectory(path, false);
    let origin: string;
    try {
      if (!(await git(path, ['remote'])).split('\n').includes('origin')) continue;
      origin = await git(path, ['remote', 'get-url', 'origin']);
    } catch (error) {
      if (isFilesystemAccessError(error)) throw error;
      throw new Error('dispatch-project-inventory-unavailable', { cause: error });
    }
    if (githubOrigin(origin) === input.repository.toLowerCase())
      matches.push({ id: project.projectId, path });
  }
  if (matches.length !== 1)
    throw new Error(matches.length ? 'dispatch-project-ambiguous' : 'dispatch-project-missing');
  const project = matches[0]!;
  if (
    (await git(project.path, ['rev-parse', '--is-bare-repository'])) !== 'false' ||
    (await git(project.path, ['rev-parse', '--show-toplevel'])) !== project.path
  )
    throw new RepositoryPreparationError('dispatch-project-workspace-required', project.path);
  const branch = input.defaultBranch;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch))
    throw new Error('dispatch-starting-ref-invalid');
  await git(project.path, ['check-ref-format', 'refs/heads/' + branch]);
  const ref = 'refs/remotes/origin/' + branch;
  await git(project.path, ['fetch', '--no-tags', 'origin', 'refs/heads/' + branch + ':' + ref]);
  const commit = await git(project.path, ['rev-parse', '--verify', ref + '^{commit}']);
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('dispatch-starting-ref-invalid');
  const commonDir = await realpath(
    await git(project.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  return { ...project, commonDir, ref, commit };
}

/** prove worktree ownership; assessments additionally require the unchanged starting checkout. */
export async function verifyDispatchWorktree(
  project: DispatchProject,
  cwd: string,
  repository: string,
  git: DispatchGit = dispatchGit,
  purpose: 'assessment' | 'handoff' = 'assessment',
) {
  const path = await realpath(cwd);
  if (path === project.path) throw new Error('dispatch-worktree-required');
  if (
    githubOrigin(await git(path, ['remote', 'get-url', 'origin'])) !== repository.toLowerCase() ||
    (await realpath(
      await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    )) !== project.commonDir ||
    (purpose === 'assessment' && (await git(path, ['rev-parse', 'HEAD'])) !== project.commit)
  )
    throw new Error('dispatch-worktree-diverged');
  if (purpose === 'assessment' && (await git(path, ['status', '--porcelain=v1'])))
    throw new Error('dispatch-assessment-worktree-changed');
  return path;
}
