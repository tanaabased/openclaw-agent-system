import { join, resolve } from 'node:path';

import PrivateStateFile from '../core/private-state-file.ts';

export interface StoredPathProjection {
  agentId: string;
  openClawPaths: string[];
  schemaVersion: 1;
  workspaceDir: string;
}

export interface PathProjectionStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

const maximumPathProjectionBytes = 64 * 1024;

function isStoredPathProjection(value: unknown): value is StoredPathProjection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredPathProjection>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.agentId === 'string' &&
    candidate.agentId.length > 0 &&
    typeof candidate.workspaceDir === 'string' &&
    candidate.workspaceDir.length > 0 &&
    Array.isArray(candidate.openClawPaths) &&
    candidate.openClawPaths.every((path) => typeof path === 'string' && path.length > 0)
  );
}

/** Persist the last Agent System-owned OpenClaw prefix outside the workspace repository. */
export default class PathProjectionStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: PathProjectionStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<StoredPathProjection | undefined> {
    const file = this.#file(agentId);
    if (!file) return undefined;
    const contents = await file.read();
    if (contents === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error('The path projection receipt is invalid.', { cause: error });
    }
    if (!isStoredPathProjection(value) || value.agentId !== agentId) {
      throw new Error('The path projection receipt is invalid.');
    }
    return value;
  }

  async write(state: StoredPathProjection): Promise<void> {
    const file = this.#file(state.agentId);
    if (!file) {
      throw new Error('The path projection store does not have a usable configuration directory.');
    }
    await file.write(`${JSON.stringify(state, undefined, 2)}\n`);
  }

  #file(agentId: string): PrivateStateFile | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    return new PrivateStateFile({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir],
      label: 'path projection receipt',
      maximumBytes: maximumPathProjectionBytes,
      path: join(agentDir, 'path-projection.json'),
    });
  }
}
