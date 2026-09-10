import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  createGitHubNotificationConversationState,
  decodeGitHubNotificationConversationIndex,
  decodeGitHubNotificationConversationRecord,
  decodeGitHubNotificationConversationState,
  type GitHubNotificationConversationIndex,
  type GitHubNotificationConversationSnapshot,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';

const maximumStateBytes = 1024 * 1024;
const stateName = 'github-notification-conversations';
const lockOptions = {
  retries: { factor: 1, maxTimeout: 25, minTimeout: 25, retries: 40 },
  staleMs: 30_000,
};
type ConversationIndex = GitHubNotificationConversationIndex | GitHubNotificationConversationState;

export interface GitHubNotificationConversationStateStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

/** Persist each lifecycle independently, with a small shared routing index. */
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
    const index = await this.#readIndex(agentId);
    if (!index) return undefined;
    return this.#snapshot(index, conversationId);
  }

  /** Recover an exact or uniquely normalized durable key for OpenClaw routing. */
  async readRouted(
    agentId: string,
    routedConversationId: string,
  ): Promise<GitHubNotificationConversationSnapshot | undefined> {
    const index = await this.#readIndex(agentId);
    if (!index) return undefined;
    const ids = this.#ids(index);
    if (ids.includes(routedConversationId)) return this.#snapshot(index, routedConversationId);
    const normalized = routedConversationId.toLowerCase();
    const matches = ids.filter((candidate) => candidate.toLowerCase() === normalized);
    return matches.length === 1 ? this.#snapshot(index, matches[0]!) : undefined;
  }

  #ids(index: ConversationIndex): string[] {
    return index.schemaVersion === 8 ? index.conversationIds : Object.keys(index.conversations);
  }

  async #snapshot(
    index: ConversationIndex,
    conversationId: string,
  ): Promise<GitHubNotificationConversationSnapshot> {
    const snapshot = {
      agentId: index.agentId,
      conversationId,
      workspaceDir: index.workspaceDir,
    };
    if (index.schemaVersion === 7) {
      return {
        ...snapshot,
        ...(Object.hasOwn(index.conversations, conversationId)
          ? { conversation: index.conversations[conversationId]! }
          : {}),
      };
    }
    if (!index.conversationIds.includes(conversationId)) return snapshot;
    const file = this.#recordFile(index.agentId, conversationId);
    const contents = await file.read();
    if (contents === undefined) {
      throw new Error('The GitHub notification conversation record is missing.');
    }
    const decoded = decodeGitHubNotificationConversationRecord(
      this.#parse(contents),
      index,
      conversationId,
    );
    if (!decoded) throw new Error('The GitHub notification conversation state is invalid.');
    return decoded;
  }

  #parse(contents: string): unknown {
    try {
      return JSON.parse(contents);
    } catch (error) {
      throw new Error('The GitHub notification conversation state is invalid.', { cause: error });
    }
  }

  async #readIndex(agentId: string): Promise<ConversationIndex | undefined> {
    const file = this.#indexFile(agentId);
    if (!file) return undefined;
    const contents = await file.read();
    if (contents === undefined) return undefined;
    const value = this.#parse(contents);
    const index =
      decodeGitHubNotificationConversationIndex(value, agentId) ??
      decodeGitHubNotificationConversationState(value, agentId);
    if (!index) throw new Error('The GitHub notification conversation state is invalid.');
    return index;
  }

  /** Save an indexed lifecycle without taking the shared index lock. */
  async write(snapshot: GitHubNotificationConversationSnapshot): Promise<void> {
    if (!snapshot.conversation) {
      throw new Error('The GitHub notification conversation checkpoint is missing.');
    }
    const file = this.#indexFile(snapshot.agentId);
    if (!file) throw new Error('The GitHub notification conversation state store is unavailable.');
    const validated = decodeGitHubNotificationConversationRecord(
      { ...snapshot, schemaVersion: 1 },
      snapshot,
      snapshot.conversationId,
    );
    if (!validated) throw new Error('The GitHub notification conversation state is invalid.');
    const index = await this.#readIndex(snapshot.agentId);
    if (index?.schemaVersion === 8 && index.conversationIds.includes(snapshot.conversationId)) {
      this.#assertWorkspace(index, snapshot);
      // a missing or corrupt indexed record must not silently reset publication receipts.
      await this.#snapshot(index, snapshot.conversationId);
      await this.#writeRecord(validated);
      return;
    }

    await this.#ensureDirectories(snapshot.agentId);
    const lock = await acquirePrivateStateFileLock(this.#indexPath(snapshot.agentId), lockOptions);
    try {
      const latest =
        (await this.#readIndex(snapshot.agentId)) ??
        createGitHubNotificationConversationState(snapshot.agentId, snapshot.workspaceDir);
      this.#assertWorkspace(latest, snapshot);
      if (latest.schemaVersion === 8 && latest.conversationIds.includes(snapshot.conversationId)) {
        await this.#snapshot(latest, snapshot.conversationId);
        await this.#writeRecord(validated);
        return;
      }
      const next = decodeGitHubNotificationConversationIndex(
        {
          agentId: latest.agentId,
          conversationIds: [...new Set([...this.#ids(latest), snapshot.conversationId])],
          schemaVersion: 8,
          workspaceDir: latest.workspaceDir,
        },
        snapshot.agentId,
      );
      if (!next) throw new Error('The GitHub notification conversation state is invalid.');
      if (latest.schemaVersion === 7) {
        // retain the original bytes; incomplete copies are unreferenced until index cutover.
        const original = await file.read();
        if (original !== undefined) {
          await this.#file(snapshot.agentId, `${stateName}.legacy.json`).write(original);
        }
        for (const conversationId of this.#ids(latest)) {
          if (conversationId !== snapshot.conversationId) {
            await this.#writeRecord(await this.#snapshot(latest, conversationId));
          }
        }
      }
      await this.#writeRecord(validated);
      // publish the index only after every referenced record has been written atomically.
      await file.write(`${JSON.stringify(next, undefined, 2)}\n`);
    } finally {
      await lock.release();
    }
  }

  #assertWorkspace(
    index: ConversationIndex,
    snapshot: GitHubNotificationConversationSnapshot,
  ): void {
    if (index.workspaceDir !== snapshot.workspaceDir) {
      throw new Error('The GitHub notification conversation belongs to another workspace.');
    }
  }

  async #writeRecord(snapshot: GitHubNotificationConversationSnapshot): Promise<void> {
    await this.#ensureDirectories(snapshot.agentId, true);
    const path = this.#recordPath(snapshot.agentId, snapshot.conversationId);
    const lock = await acquirePrivateStateFileLock(path, lockOptions);
    try {
      await this.#recordFile(snapshot.agentId, snapshot.conversationId).write(
        `${JSON.stringify({ ...snapshot, schemaVersion: 1 }, undefined, 2)}\n`,
      );
    } finally {
      await lock.release();
    }
  }

  #directories(agentId: string, records = false): string[] {
    const agentDir = join(this.#rootDir!, agentId);
    const stateDir = join(agentDir, 'channels');
    return [this.#rootDir!, agentDir, stateDir, ...(records ? [join(stateDir, stateName)] : [])];
  }

  async #ensureDirectories(agentId: string, records = false): Promise<void> {
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: this.#directories(agentId, records),
      label: 'GitHub notification conversation state',
    });
  }

  #indexPath(agentId: string): string {
    return join(this.#rootDir!, agentId, 'channels', `${stateName}.json`);
  }

  #recordPath(agentId: string, conversationId: string): string {
    const digest = createHash('sha256').update(conversationId).digest('hex');
    return join(this.#rootDir!, agentId, 'channels', stateName, `${digest}.json`);
  }

  #indexFile(agentId: string): PrivateStateFile | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    return this.#file(agentId, `${stateName}.json`);
  }

  #recordFile(agentId: string, conversationId: string): PrivateStateFile {
    return this.#file(agentId, this.#recordPath(agentId, conversationId), true);
  }

  #file(agentId: string, name: string, records = false): PrivateStateFile {
    return new PrivateStateFile({
      currentUid: this.#currentUid,
      directories: this.#directories(agentId, records),
      label: 'GitHub notification conversation state',
      maximumBytes: maximumStateBytes,
      path: records ? name : join(this.#rootDir!, agentId, 'channels', name),
    });
  }
}
