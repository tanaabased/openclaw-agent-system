import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { acquireFileLock, type FileLockHandle } from 'openclaw/plugin-sdk/file-lock';

import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';

const defaultTtlMs = 30 * 60 * 1000;
const maximumStateBytes = 4 * 1024;

export type GitHubNotificationReplyCandidateStoreErrorCode =
  | 'reply-turn-already-active'
  | 'reply-turn-candidate-limit'
  | 'reply-turn-expired'
  | 'reply-turn-mismatch'
  | 'reply-turn-missing'
  | 'reply-turn-state-invalid'
  | 'reply-turn-store-unavailable';

export class GitHubNotificationReplyCandidateStoreError extends Error {
  override name = 'GitHubNotificationReplyCandidateStoreError';

  constructor(readonly code: GitHubNotificationReplyCandidateStoreErrorCode) {
    super('The GitHub notification reply candidate turn is unavailable.');
  }
}

interface GitHubNotificationReplyCandidateState {
  agentId: string;
  candidates: Array<{ body: string; stagedAt: string }>;
  conversationId: string;
  expiresAt: string;
  openedAt: string;
  revisionId: string;
  schemaVersion: 1;
  turnId: string;
}

export interface GitHubNotificationReplyCandidateTurnInput {
  agentId: string;
  conversationId: string;
  revisionId: string;
}

export interface GitHubNotificationReplyCandidateFinishInput extends GitHubNotificationReplyCandidateTurnInput {
  turnId: string;
}

export interface GitHubNotificationReplyCandidateStoreDependencies {
  acquireFileLock?: typeof acquireFileLock;
  currentUid?: number;
  now?: () => number;
  randomId?: () => string;
  rootDir?: string;
  ttlMs?: number;
}

function fail(code: GitHubNotificationReplyCandidateStoreErrorCode): never {
  throw new GitHubNotificationReplyCandidateStoreError(code);
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function decodeState(
  value: unknown,
  expectedAgentId: string,
): GitHubNotificationReplyCandidateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('reply-turn-state-invalid');
  }
  const state = value as Record<string, unknown>;
  const candidates = state.candidates;
  if (
    state.schemaVersion !== 1 ||
    state.agentId !== expectedAgentId ||
    !boundedString(state.turnId, 128) ||
    !boundedString(state.conversationId, 512) ||
    !boundedString(state.revisionId, 256) ||
    !boundedString(state.openedAt, 64) ||
    !boundedString(state.expiresAt, 64) ||
    !Number.isFinite(Date.parse(state.openedAt)) ||
    !Number.isFinite(Date.parse(state.expiresAt)) ||
    !Array.isArray(candidates) ||
    candidates.length > 2
  ) {
    fail('reply-turn-state-invalid');
  }
  const decodedCandidates = candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('reply-turn-state-invalid');
    }
    const entry = candidate as Record<string, unknown>;
    if (
      !boundedString(entry.body, 800) ||
      entry.body !== entry.body.trim() ||
      !boundedString(entry.stagedAt, 64) ||
      !Number.isFinite(Date.parse(entry.stagedAt))
    ) {
      fail('reply-turn-state-invalid');
    }
    return { body: entry.body, stagedAt: entry.stagedAt };
  });
  return {
    agentId: expectedAgentId,
    candidates: decodedCandidates,
    conversationId: state.conversationId,
    expiresAt: state.expiresAt,
    openedAt: state.openedAt,
    revisionId: state.revisionId,
    schemaVersion: 1,
    turnId: state.turnId,
  };
}

/** Exchange one bounded reply candidate across Gateway and native harness runtimes. */
export default class GitHubNotificationReplyCandidateStore {
  readonly #acquireFileLock: typeof acquireFileLock;
  readonly #currentUid: number | undefined;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #rootDir: string | undefined;
  readonly #ttlMs: number;

  constructor(dependencies: GitHubNotificationReplyCandidateStoreDependencies = {}) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquireFileLock;
    this.#currentUid = dependencies.currentUid;
    this.#now = dependencies.now ?? Date.now;
    this.#randomId = dependencies.randomId ?? randomUUID;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
    this.#ttlMs = dependencies.ttlMs ?? defaultTtlMs;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error('GitHub notification reply candidate expiry must be positive.');
    }
  }

  async begin(input: GitHubNotificationReplyCandidateTurnInput): Promise<string> {
    return this.#exclusive(input.agentId, async (file) => {
      const active = await this.#read(file, input.agentId);
      if (active && !this.#expired(active)) fail('reply-turn-already-active');
      if (active) await file.remove();
      const openedAt = this.#now();
      const state: GitHubNotificationReplyCandidateState = {
        agentId: input.agentId,
        candidates: [],
        conversationId: input.conversationId,
        expiresAt: new Date(openedAt + this.#ttlMs).toISOString(),
        openedAt: new Date(openedAt).toISOString(),
        revisionId: input.revisionId,
        schemaVersion: 1,
        turnId: this.#randomId(),
      };
      await file.write(`${JSON.stringify(state, undefined, 2)}\n`);
      return state.turnId;
    });
  }

  async cancel(input: GitHubNotificationReplyCandidateFinishInput): Promise<void> {
    await this.#exclusive(input.agentId, async (file) => {
      const active = await this.#read(file, input.agentId);
      if (active?.turnId === input.turnId) await file.remove();
    });
  }

  async finish(input: GitHubNotificationReplyCandidateFinishInput): Promise<string[]> {
    return this.#exclusive(input.agentId, async (file) => {
      const active = await this.#matchingState(file, input);
      await file.remove();
      return active.candidates.map(({ body }) => body);
    });
  }

  async stage(agentId: string, candidate: string): Promise<void> {
    await this.#exclusive(agentId, async (file) => {
      const active = await this.#read(file, agentId);
      if (!active) fail('reply-turn-missing');
      if (this.#expired(active)) {
        await file.remove();
        fail('reply-turn-expired');
      }
      if (active.candidates.length >= 2) fail('reply-turn-candidate-limit');
      const body = candidate.trim();
      if (!body || body.length > 800) fail('reply-turn-state-invalid');
      active.candidates.push({ body, stagedAt: new Date(this.#now()).toISOString() });
      await file.write(`${JSON.stringify(active, undefined, 2)}\n`);
    });
  }

  #expired(state: GitHubNotificationReplyCandidateState): boolean {
    return Date.parse(state.expiresAt) <= this.#now();
  }

  async #matchingState(
    file: PrivateStateFile,
    input: GitHubNotificationReplyCandidateFinishInput,
  ): Promise<GitHubNotificationReplyCandidateState> {
    const active = await this.#read(file, input.agentId);
    if (!active) fail('reply-turn-missing');
    if (this.#expired(active)) {
      await file.remove();
      fail('reply-turn-expired');
    }
    if (
      active.turnId !== input.turnId ||
      active.conversationId !== input.conversationId ||
      active.revisionId !== input.revisionId
    ) {
      fail('reply-turn-mismatch');
    }
    return active;
  }

  async #read(
    file: PrivateStateFile,
    agentId: string,
  ): Promise<GitHubNotificationReplyCandidateState | undefined> {
    const contents = await file.read();
    if (contents === undefined) return undefined;
    try {
      return decodeState(JSON.parse(contents), agentId);
    } catch (error) {
      if (error instanceof GitHubNotificationReplyCandidateStoreError) throw error;
      fail('reply-turn-state-invalid');
    }
  }

  async #exclusive<T>(agentId: string, run: (file: PrivateStateFile) => Promise<T>): Promise<T> {
    const resources = await this.#resources(agentId);
    let handle: FileLockHandle | undefined;
    try {
      handle = await this.#acquireFileLock(resources.lockPath, {
        retries: { factor: 1, maxTimeout: 25, minTimeout: 25, retries: 40 },
        stale: defaultTtlMs,
      });
      return await run(resources.file);
    } finally {
      await handle?.release();
    }
  }

  async #resources(agentId: string): Promise<{ file: PrivateStateFile; lockPath: string }> {
    if (!this.#rootDir || !validAgentId(agentId)) fail('reply-turn-store-unavailable');
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir],
      label: 'GitHub notification reply candidate',
    });
    return {
      file: new PrivateStateFile({
        currentUid: this.#currentUid,
        directories: [this.#rootDir, agentDir, stateDir],
        label: 'GitHub notification reply candidate',
        maximumBytes: maximumStateBytes,
        path: join(stateDir, 'github-notification-reply-turn.json'),
      }),
      lockPath: join(stateDir, 'github-notification-reply-turn'),
    };
  }
}
