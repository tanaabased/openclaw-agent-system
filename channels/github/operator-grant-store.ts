import { isAbsolute, join, resolve } from 'node:path';

import PrivateStateFile from '../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import { githubNotificationChannelId } from './routing/routing.ts';

export interface OperatorGrantClaim {
  agentId: string;
  workspaceDir: string;
}

export interface OperatorGrant {
  identity: string;
  origin: 'created' | 'preexisting' | 'ambiguous';
  claims: OperatorGrantClaim[];
}

export interface OperatorGrantState {
  schemaVersion: 1;
  grants: OperatorGrant[];
}

export function validOperatorGrantState(value: unknown): value is OperatorGrantState {
  if (!value || typeof value !== 'object') return false;
  const state = value as OperatorGrantState;
  if (state.schemaVersion !== 1 || !Array.isArray(state.grants)) return false;
  const identities = new Set<string>();
  return state.grants.every((grant) => {
    if (
      !grant ||
      typeof grant.identity !== 'string' ||
      !grant.identity.startsWith(`${githubNotificationChannelId}:`) ||
      !/^[^\s:]+:[^\s:]+$/u.test(grant.identity) ||
      grant.identity.includes('\0') ||
      grant.identity.length > 300 ||
      identities.has(grant.identity) ||
      !['created', 'preexisting', 'ambiguous'].includes(grant.origin) ||
      !Array.isArray(grant.claims)
    )
      return false;
    identities.add(grant.identity);
    const claims = new Set<string>();
    return grant.claims.every((claim) => {
      if (
        !claim ||
        typeof claim.agentId !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(claim.agentId) ||
        typeof claim.workspaceDir !== 'string' ||
        !isAbsolute(claim.workspaceDir) ||
        resolve(claim.workspaceDir) !== claim.workspaceDir ||
        claim.workspaceDir.includes('\0') ||
        /[\r\n]/u.test(claim.workspaceDir)
      )
        return false;
      const key = JSON.stringify(claim);
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    });
  });
}

/** Keep grant provenance shared across installations, outside their repositories. */
export default class OperatorGrantStore {
  readonly #root: string | undefined;
  readonly #file: PrivateStateFile | undefined;

  constructor(readonly options: { currentUid?: number; rootDir?: string }) {
    this.#root = options.rootDir ? resolve(options.rootDir) : undefined;
    this.#file = this.#root
      ? new PrivateStateFile({
          currentUid: options.currentUid,
          directories: [this.#root],
          label: 'GitHub operator grant ledger',
          maximumBytes: 1024 * 1024,
          path: join(this.#root, 'github-operator-grants.json'),
        })
      : undefined;
  }

  async read(): Promise<OperatorGrantState> {
    if (!this.#file) throw new Error('Operator grant provenance is unavailable.');
    const contents = await this.#file.read();
    if (contents === undefined) return { schemaVersion: 1, grants: [] };
    const state: unknown = JSON.parse(contents);
    if (!validOperatorGrantState(state)) throw new Error('Operator grant provenance is invalid.');
    return state;
  }

  async write(state: OperatorGrantState): Promise<void> {
    if (!this.#file || !validOperatorGrantState(state)) {
      throw new Error('Operator grant provenance cannot be saved.');
    }
    await this.#file.write(`${JSON.stringify(state, undefined, 2)}\n`);
  }

  async withLock<T>(run: () => Promise<T>): Promise<T> {
    if (!this.#root) throw new Error('Operator grant provenance is unavailable.');
    await ensurePrivateStateDirectories({
      currentUid: this.options.currentUid,
      directories: [this.#root],
      label: 'GitHub operator grant ledger',
    });
    const lock = await acquirePrivateStateFileLock(
      join(this.#root, 'github-operator-grants.json'),
      {
        retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
        staleMs: 30_000,
      },
    );
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }
}
