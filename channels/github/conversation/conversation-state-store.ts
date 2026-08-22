import { join, resolve } from 'node:path';

import {
  decodeGitHubNotificationConversationState,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';

const maximumStateBytes = 1024 * 1024;

export interface GitHubNotificationConversationStateStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

/** Persist lifecycle conversation receipts separately from provider intake. */
export default class GitHubNotificationConversationStateStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: GitHubNotificationConversationStateStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<GitHubNotificationConversationState | undefined> {
    const file = this.#file(agentId);
    if (!file) return undefined;
    const contents = await file.read();
    if (contents === undefined) return undefined;
    try {
      const state = decodeGitHubNotificationConversationState(JSON.parse(contents), agentId);
      if (state) return state;
    } catch (error) {
      throw new Error('The GitHub notification conversation state is invalid.', { cause: error });
    }
    throw new Error('The GitHub notification conversation state is invalid.');
  }

  async write(state: GitHubNotificationConversationState): Promise<void> {
    const decoded = decodeGitHubNotificationConversationState(state, state.agentId);
    if (!decoded) throw new Error('The GitHub notification conversation state is invalid.');
    const file = this.#file(state.agentId);
    if (!file) throw new Error('The GitHub notification conversation state store is unavailable.');
    await file.write(`${JSON.stringify(decoded, undefined, 2)}\n`);
  }

  #file(agentId: string): PrivateStateFile | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    return new PrivateStateFile({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir],
      label: 'GitHub notification conversation state',
      maximumBytes: maximumStateBytes,
      path: join(stateDir, 'github-notification-conversations.json'),
    });
  }
}
