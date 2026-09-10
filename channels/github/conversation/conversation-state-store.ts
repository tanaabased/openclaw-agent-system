import { join, resolve } from 'node:path';

import {
  createGitHubNotificationConversationState,
  decodeGitHubNotificationConversationState,
  type GitHubNotificationConversationSnapshot,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';

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

  async read(
    agentId: string,
    conversationId: string,
  ): Promise<GitHubNotificationConversationSnapshot | undefined> {
    const state = await this.#read(agentId);
    if (!state) return undefined;
    return this.#snapshot(state, conversationId);
  }

  /** Recover an exact or uniquely normalized durable key for OpenClaw routing. */
  async readRouted(
    agentId: string,
    routedConversationId: string,
  ): Promise<GitHubNotificationConversationSnapshot | undefined> {
    const state = await this.#read(agentId);
    if (!state) return undefined;
    if (Object.hasOwn(state.conversations, routedConversationId)) {
      return this.#snapshot(state, routedConversationId);
    }
    const normalized = routedConversationId.toLowerCase();
    const matches = Object.keys(state.conversations).filter(
      (candidate) => candidate.toLowerCase() === normalized,
    );
    return matches.length === 1 ? this.#snapshot(state, matches[0]!) : undefined;
  }

  #snapshot(
    state: GitHubNotificationConversationState,
    conversationId: string,
  ): GitHubNotificationConversationSnapshot {
    return {
      agentId: state.agentId,
      conversationId,
      workspaceDir: state.workspaceDir,
      ...(Object.hasOwn(state.conversations, conversationId)
        ? { conversation: state.conversations[conversationId]! }
        : {}),
    };
  }

  async #read(agentId: string): Promise<GitHubNotificationConversationState | undefined> {
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

  /** Replace one lifecycle record while retaining other conversations' latest checkpoints. */
  async write(snapshot: GitHubNotificationConversationSnapshot): Promise<void> {
    if (!snapshot.conversation) {
      throw new Error('The GitHub notification conversation checkpoint is missing.');
    }
    const file = this.#file(snapshot.agentId);
    if (!file) throw new Error('The GitHub notification conversation state store is unavailable.');
    const agentDir = join(this.#rootDir!, snapshot.agentId);
    const stateDir = join(agentDir, 'channels');
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: [this.#rootDir!, agentDir, stateDir],
      label: 'GitHub notification conversation state',
    });
    const lock = await acquirePrivateStateFileLock(
      join(stateDir, 'github-notification-conversations.json'),
      { retries: { factor: 1, maxTimeout: 25, minTimeout: 25, retries: 40 }, staleMs: 30_000 },
    );
    try {
      const state =
        (await this.#read(snapshot.agentId)) ??
        createGitHubNotificationConversationState(snapshot.agentId, snapshot.workspaceDir);
      if (state.workspaceDir !== snapshot.workspaceDir) {
        throw new Error('The GitHub notification conversation belongs to another workspace.');
      }
      state.conversations[snapshot.conversationId] = snapshot.conversation;
      const decoded = decodeGitHubNotificationConversationState(state, snapshot.agentId);
      if (!decoded) throw new Error('The GitHub notification conversation state is invalid.');
      await file.write(`${JSON.stringify(decoded, undefined, 2)}\n`);
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
      label: 'GitHub notification conversation state',
      maximumBytes: maximumStateBytes,
      path: join(stateDir, 'github-notification-conversations.json'),
    });
  }
}
