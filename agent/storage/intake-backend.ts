import IntakeRecordStore, {
  type intakeLocation,
} from '../../channels/github/intake/record-store.ts';
import type { BoundStorage, SqliteInstallation } from './storage-lifecycle.ts';

export type StorageBackend = 'file' | 'sqlite';
export const defaultStorageBackend: StorageBackend = 'file';

export function sqliteIntakeStore(
  location: ReturnType<typeof intakeLocation>,
  agent: Pick<BoundStorage['agent'], 'readIntake' | 'saveIntake'>,
) {
  return new IntakeRecordStore(location, {
    read: () => agent.readIntake(location.scope),
    save: (state) => agent.saveIntake(state),
  });
}

export async function bindIntakeStore(
  location: ReturnType<typeof intakeLocation>,
  agentId: string,
  installation: SqliteInstallation | undefined,
  backend = defaultStorageBackend,
) {
  if (backend === 'file') return new IntakeRecordStore(location);
  if (!installation) throw new Error('SQLite intake requires runtime storage locations');
  const { bindSqliteStorage } = await import('./agent-database.ts');
  return sqliteIntakeStore(location, bindSqliteStorage(installation, agentId).agent);
}
