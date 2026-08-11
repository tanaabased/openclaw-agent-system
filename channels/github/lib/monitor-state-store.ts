import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';

const maximumStateBytes = 1024 * 1024;

export interface GitHubNotificationMonitorStateStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validNodeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes('\0') &&
    !/\s/u.test(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function validItem(value: unknown): value is GitHubNotificationItemState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<GitHubNotificationItemState>;
  const allowedKeys = new Set([
    'accountLogin',
    'accountNodeId',
    'assignmentActorNodeId',
    'assignmentEventNodeId',
    'disposition',
    'itemNodeId',
    'itemType',
    'lastObservedAt',
    'number',
    'reasonCode',
    'repositoryCloneUrl',
    'repositoryDatabaseId',
    'repositoryDefaultBranch',
    'repositoryName',
    'repositoryNodeId',
    'repositoryOwner',
    'repositoryOwnerNodeId',
    'repositoryPermission',
  ]);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    ['approved', 'baseline', 'rejected', 'retired'].includes(item.disposition ?? '') &&
    validNodeId(item.itemNodeId) &&
    (item.itemType === 'issue' || item.itemType === 'pull-request') &&
    typeof item.lastObservedAt === 'number' &&
    Number.isFinite(item.lastObservedAt) &&
    Number.isSafeInteger(item.number) &&
    Number(item.number) > 0 &&
    typeof item.reasonCode === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(item.reasonCode) &&
    Number.isSafeInteger(item.repositoryDatabaseId) &&
    Number(item.repositoryDatabaseId) >= 0 &&
    typeof item.repositoryCloneUrl === 'string' &&
    item.repositoryCloneUrl.length > 0 &&
    typeof item.repositoryDefaultBranch === 'string' &&
    item.repositoryDefaultBranch.length > 0 &&
    item.repositoryDefaultBranch.length <= 255 &&
    !hasControlCharacter(item.repositoryDefaultBranch) &&
    typeof item.repositoryName === 'string' &&
    /^[A-Za-z0-9_.-]+$/u.test(item.repositoryName) &&
    validNodeId(item.repositoryNodeId) &&
    typeof item.repositoryOwner === 'string' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(item.repositoryOwner) &&
    item.repositoryCloneUrl.toLowerCase() ===
      `https://github.com/${item.repositoryOwner}/${item.repositoryName}.git`.toLowerCase() &&
    validNodeId(item.repositoryOwnerNodeId) &&
    ['admin', 'maintain', 'none', 'read', 'triage', 'write'].includes(
      item.repositoryPermission ?? '',
    ) &&
    (item.assignmentActorNodeId === undefined || validNodeId(item.assignmentActorNodeId)) &&
    (item.assignmentEventNodeId === undefined || validNodeId(item.assignmentEventNodeId))
  );
}

function validState(value: unknown): value is GitHubNotificationMonitorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<GitHubNotificationMonitorState>;
  const allowedKeys = new Set([
    'agentId',
    'baselineAt',
    'baselineItemNodeIds',
    'diagnosticCode',
    'failureCount',
    'items',
    'lastPollAt',
    'lastSuccessfulPollAt',
    'nextPollAt',
    'processedEventNodeIds',
    'schemaVersion',
    'searchBoundary',
    'workspaceDir',
  ]);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    state.schemaVersion === 1 &&
    ((state.accountLogin === undefined && state.accountNodeId === undefined) ||
      (typeof state.accountLogin === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(state.accountLogin) &&
        validNodeId(state.accountNodeId))) &&
    typeof state.agentId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(state.agentId) &&
    typeof state.workspaceDir === 'string' &&
    state.workspaceDir.length > 0 &&
    Number.isSafeInteger(state.failureCount) &&
    Number(state.failureCount) >= 0 &&
    optionalFiniteNumber(state.baselineAt) &&
    optionalFiniteNumber(state.lastPollAt) &&
    optionalFiniteNumber(state.lastSuccessfulPollAt) &&
    optionalFiniteNumber(state.nextPollAt) &&
    (state.diagnosticCode === undefined || typeof state.diagnosticCode === 'string') &&
    (state.searchBoundary === undefined || !Number.isNaN(Date.parse(state.searchBoundary))) &&
    Array.isArray(state.baselineItemNodeIds) &&
    state.baselineItemNodeIds.length <= 2_000 &&
    state.baselineItemNodeIds.every(validNodeId) &&
    new Set(state.baselineItemNodeIds).size === state.baselineItemNodeIds.length &&
    Array.isArray(state.processedEventNodeIds) &&
    state.processedEventNodeIds.length <= 2_000 &&
    state.processedEventNodeIds.every(validNodeId) &&
    new Set(state.processedEventNodeIds).size === state.processedEventNodeIds.length &&
    state.items !== undefined &&
    !Array.isArray(state.items) &&
    Object.entries(state.items).every(
      ([key, item]) => validItem(item) && key === `github:${item.repositoryNodeId}:${item.number}`,
    )
  );
}

/** Persist value-free GitHub monitor control state with private atomic replacement. */
export default class GitHubNotificationMonitorStateStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: GitHubNotificationMonitorStateStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<GitHubNotificationMonitorState | undefined> {
    const paths = this.#paths(agentId);
    if (!paths) return undefined;
    for (const directory of paths.directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return undefined;
    }
    let handle;
    try {
      handle = await open(paths.statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      if (errorCode(error) === 'ELOOP') {
        throw new Error('The GitHub notification monitor state may not be a symbolic link.', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('The GitHub notification monitor state must be a file.');
      if (!hasPrivateMode(stats.mode)) {
        throw new Error(
          'The GitHub notification monitor state must be private to the current user.',
        );
      }
      if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
        throw new Error('The GitHub notification monitor state must be owned by the current user.');
      }
      if (stats.size > maximumStateBytes) {
        throw new Error('The GitHub notification monitor state exceeds its size limit.');
      }
      const value = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (!validState(value) || value.agentId !== agentId) {
        throw new Error('The GitHub notification monitor state is invalid.');
      }
      return value;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(state: GitHubNotificationMonitorState): Promise<void> {
    if (!validState(state)) throw new Error('The GitHub notification monitor state is invalid.');
    const paths = this.#paths(state.agentId);
    if (!paths) throw new Error('The GitHub notification monitor state store is unavailable.');
    for (const [index, directory] of paths.directories.entries()) {
      await this.#ensureDirectory(directory, index === 0);
    }
    try {
      const stats = await lstat(paths.statePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('The GitHub notification monitor state must be a regular file.');
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    const temporaryPath = join(paths.stateDir, `.monitor.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(state, undefined, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.statePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async remove(agentId: string): Promise<boolean> {
    const paths = this.#paths(agentId);
    if (!paths) return false;
    for (const directory of paths.directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return false;
    }
    try {
      const stats = await lstat(paths.statePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('The GitHub notification monitor state must be a regular file.');
      }
      if (!hasPrivateMode(stats.mode)) {
        throw new Error(
          'The GitHub notification monitor state must be private to the current user.',
        );
      }
      if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
        throw new Error('The GitHub notification monitor state must be owned by the current user.');
      }
      await unlink(paths.statePath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async #ensureDirectory(path: string, recursive: boolean): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700, recursive });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if ((await this.#inspectDirectory(path)) !== 'ready') {
      throw new Error('A GitHub notification monitor state directory is unavailable.');
    }
  }

  async #inspectDirectory(path: string): Promise<'missing' | 'ready'> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('GitHub notification monitor state directories must be real directories.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('GitHub notification monitor state directories must be private.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error(
        'GitHub notification monitor state directories must be owned by the current user.',
      );
    }
    return 'ready';
  }

  #paths(
    agentId: string,
  ): { directories: string[]; stateDir: string; statePath: string } | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    return {
      directories: [this.#rootDir, agentDir, stateDir],
      stateDir,
      statePath: join(stateDir, 'github-notifications.json'),
    };
  }
}
