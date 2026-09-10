import { join, resolve } from 'node:path';

import decodeGitHubNotificationMonitorState from './state-codec.ts';
import type { GitHubNotificationMonitorState } from './state.ts';
import PrivateStateFile from '../../../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../../../core/ensure-private-state-directories.ts';

const maximumStateBytes = 1024 * 1024;

export interface GitHubNotificationMonitorStateStoreDependencies {
  acquireFileLock?: typeof acquirePrivateStateFileLock;
  currentUid?: number;
  rootDir?: string;
}

export type GitHubNotificationMonitorStateUpdate = (
  current: GitHubNotificationMonitorState | undefined,
) => GitHubNotificationMonitorState;

export type GitHubNotificationMonitorStateLoadResult =
  { state: GitHubNotificationMonitorState; status: 'ready' } | { status: 'missing' };

/** Persist value-free GitHub monitor control state with private atomic replacement. */
export default class GitHubNotificationMonitorStateStore {
  readonly #acquireFileLock: typeof acquirePrivateStateFileLock;
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: GitHubNotificationMonitorStateStoreDependencies) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquirePrivateStateFileLock;
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<GitHubNotificationMonitorState | undefined> {
    const result = await this.load(agentId);
    return result.status === 'missing' ? undefined : result.state;
  }

  async load(agentId: string): Promise<GitHubNotificationMonitorStateLoadResult> {
    const file = this.#file(agentId);
    if (!file) return { status: 'missing' };
    const contents = await file.read();
    if (contents === undefined) return { status: 'missing' };
    try {
      const decoded = decodeGitHubNotificationMonitorState(JSON.parse(contents), agentId);
      if (decoded) return decoded;
    } catch (error) {
      throw new Error('The GitHub notification monitor state is invalid.', { cause: error });
    }
    throw new Error('The GitHub notification monitor state is invalid.');
  }

  async write(state: GitHubNotificationMonitorState): Promise<void> {
    await this.#exclusive(state.agentId, () => this.#write(state));
  }

  /** Read and patch the latest state under a short lock; callbacks must not perform I/O. */
  async update(
    agentId: string,
    patch: GitHubNotificationMonitorStateUpdate,
  ): Promise<GitHubNotificationMonitorState> {
    return this.#exclusive(agentId, async () => {
      const next = patch(await this.read(agentId));
      if (next.agentId !== agentId) {
        throw new Error('The GitHub notification monitor state belongs to another agent.');
      }
      await this.#write(next);
      return next;
    });
  }

  async #write(state: GitHubNotificationMonitorState): Promise<void> {
    const decoded = decodeGitHubNotificationMonitorState(state, state.agentId);
    if (decoded?.status !== 'ready') {
      throw new Error('The GitHub notification monitor state is invalid.');
    }
    const file = this.#file(state.agentId);
    if (!file) throw new Error('The GitHub notification monitor state store is unavailable.');
    await file.write(`${JSON.stringify(decoded.state, undefined, 2)}\n`);
  }

  async remove(
    agentId: string,
    eligible: (state: GitHubNotificationMonitorState | undefined) => boolean = () => true,
  ): Promise<boolean> {
    if (!this.#file(agentId) || !(await this.read(agentId))) return false;
    return this.#exclusive(agentId, async () => {
      if (!eligible(await this.read(agentId))) return false;
      return (await this.#file(agentId)?.remove()) ?? false;
    });
  }

  async #exclusive<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.#rootDir || !this.#file(agentId)) {
      throw new Error('The GitHub notification monitor state store is unavailable.');
    }
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir],
      label: 'GitHub notification monitor state',
    });
    // this lock is independent of the long-lived monitor cycle lease.
    const lock = await this.#acquireFileLock(join(stateDir, 'github-notifications.json'), {
      retries: { factor: 1, maxTimeout: 25, minTimeout: 25, retries: 40 },
      staleMs: 30_000,
    });
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  #file(agentId: string): PrivateStateFile | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    return new PrivateStateFile({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir],
      label: 'GitHub notification monitor state',
      maximumBytes: maximumStateBytes,
      path: join(stateDir, 'github-notifications.json'),
    });
  }
}
