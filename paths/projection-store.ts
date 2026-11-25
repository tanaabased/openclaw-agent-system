import { resolve } from 'node:path';

import type { SqliteInstallation } from '../agent/storage/storage-lifecycle.ts';
import nodeErrorCode from '../utils/node-error-code.ts';

export interface StoredPathProjection {
  agentId: string;
  openClawPaths: string[];
  schemaVersion: 1;
  workspaceDir: string;
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
  constructor(private readonly installation: SqliteInstallation) {}

  private async database(agentId: string) {
    const { bindSqliteStorage } = await import('../agent/storage/agent-database.ts');
    return bindSqliteStorage(this.installation, agentId).agent;
  }

  async read(agentId: string, workspaceDir?: string): Promise<StoredPathProjection | undefined> {
    const db = await this.database(agentId);
    const rows = await db
      .read({ pathProjections: workspaceDir ? { scope: resolve(workspaceDir) } : {} })
      .catch((error: unknown) => {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        return { pathProjections: [] };
      });
    const row = rows.pathProjections[0];
    if (!row) return;
    if (
      !isStoredPathProjection(row.value) ||
      row.scope !== row.value.workspaceDir ||
      row.value.agentId !== agentId
    )
      throw new Error('The path projection receipt is invalid.');
    return row.value;
  }

  async write(state: StoredPathProjection): Promise<void> {
    const db = await this.database(state.agentId);
    if (Buffer.byteLength(JSON.stringify(state, undefined, 2) + '\n') > maximumPathProjectionBytes)
      throw new Error('The path projection receipt exceeds its size limit.');
    await db.replacePathProjection(state);
  }
}
