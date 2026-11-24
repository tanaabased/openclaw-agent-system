import IntakeRecordStore, {
  type intakeLocation,
} from '../../channels/github/intake/record-store.ts';
import type { BoundStorage, SqliteInstallation } from './storage-lifecycle.ts';

export type StorageBackend = 'file' | 'sqlite';
export const defaultStorageBackend: StorageBackend = 'file';

export function bindIntakeStore(
  location: ReturnType<typeof intakeLocation>,
  agent?: BoundStorage['agent'],
) {
  if (!agent) return new IntakeRecordStore(location);
  return new IntakeRecordStore(
    location,
    {
      read: () => agent.readIntake(location.scope),
      save: (state) => agent.saveIntake(state),
    },
    agent,
  );
}

export async function bindAgentStore(
  agentId: string,
  installation: SqliteInstallation | undefined,
  backend = defaultStorageBackend,
) {
  if (backend === 'file') return;
  if (!installation) throw new Error('SQLite requires runtime storage locations');
  const { bindSqliteStorage } = await import('./agent-database.ts');
  return bindSqliteStorage(installation, agentId).agent;
}

export interface RuntimeStorageOptions {
  sqliteInstallation?: SqliteInstallation;
  storageBackend?: StorageBackend;
}

export async function bindInstallationStore({
  sqliteInstallation,
  storageBackend = defaultStorageBackend,
}: RuntimeStorageOptions) {
  if (storageBackend === 'file') return;
  if (!sqliteInstallation) throw new Error('SQLite requires runtime storage locations');
  const { bindSqliteInstallation } = await import('./agent-database.ts');
  return bindSqliteInstallation(sqliteInstallation);
}
