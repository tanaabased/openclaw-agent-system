import { join, resolve } from 'node:path';

import decodeGitHubNotificationMonitorState from '../utils/monitor-state-codec.ts';
import type { GitHubNotificationMonitorState } from '../utils/monitor-state.ts';
import PrivateStateFile from './private-state-file.ts';

const maximumStateBytes = 1024 * 1024;

export interface GitHubNotificationMonitorStateStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

export type GitHubNotificationMonitorStateLoadResult =
  { state: GitHubNotificationMonitorState; status: 'ready' } | { status: 'missing' };

/** Persist value-free GitHub monitor control state with private atomic replacement. */
export default class GitHubNotificationMonitorStateStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: GitHubNotificationMonitorStateStoreDependencies) {
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
    const decoded = decodeGitHubNotificationMonitorState(state, state.agentId);
    if (decoded?.status !== 'ready') {
      throw new Error('The GitHub notification monitor state is invalid.');
    }
    const file = this.#file(state.agentId);
    if (!file) throw new Error('The GitHub notification monitor state store is unavailable.');
    await file.write(`${JSON.stringify(decoded.state, undefined, 2)}\n`);
  }

  async remove(agentId: string): Promise<boolean> {
    return (await this.#file(agentId)?.remove()) ?? false;
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
