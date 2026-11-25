import IntakeRecordStore, {
  type intakeLocation,
} from '../../channels/github/intake/record-store.ts';
import type { BoundStorage, SqliteInstallation } from './storage-lifecycle.ts';

export function validateStorageConfig(storage: unknown): void {
  if (storage === undefined) return;
  if (
    storage &&
    typeof storage === 'object' &&
    !Array.isArray(storage) &&
    Object.keys(storage).every((key) => key === 'backend')
  ) {
    const backend = (storage as { backend?: unknown }).backend;
    if (backend === undefined || backend === 'sqlite') return;
    if (backend === 'file')
      throw new Error(
        'File workflow storage has been retired. Import existing records with the previous version before removing the storage.backend setting.',
      );
  }
  throw new Error(
    'Remove plugins.entries.agent-system.config.storage.backend or set it to sqlite.',
  );
}

export function bindIntakeStore(
  location: ReturnType<typeof intakeLocation>,
  agent: BoundStorage['agent'],
) {
  return new IntakeRecordStore(location, agent);
}

export async function bindAgentStore(
  agentId: string,
  installation: SqliteInstallation | undefined,
): Promise<BoundStorage['agent']> {
  if (!installation) throw new Error('SQLite requires runtime storage locations');
  const { bindSqliteStorage } = await import('./agent-database.ts');
  return bindSqliteStorage(installation, agentId).agent;
}

export interface RuntimeStorageOptions {
  sqliteInstallation?: SqliteInstallation;
}

export async function bindInstallationStore({ sqliteInstallation }: RuntimeStorageOptions) {
  if (!sqliteInstallation) throw new Error('SQLite requires runtime storage locations');
  const { bindSqliteInstallation } = await import('./agent-database.ts');
  return bindSqliteInstallation(sqliteInstallation);
}
