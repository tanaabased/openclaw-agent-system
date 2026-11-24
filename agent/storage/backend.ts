import IntakeRecordStore, {
  type intakeLocation,
} from '../../channels/github/intake/record-store.ts';
import type { BoundStorage, SqliteInstallation } from './storage-lifecycle.ts';

export type StorageBackend = 'file' | 'sqlite';
export const defaultStorageBackend: StorageBackend = 'file';

export function bindIntakeStore(
  location: ReturnType<typeof intakeLocation>,
  agent?: Pick<BoundStorage['agent'], 'readIntake' | 'saveIntake'>,
) {
  if (!agent) return new IntakeRecordStore(location);
  return new IntakeRecordStore(location, {
    read: () => agent.readIntake(location.scope),
    save: (state) => agent.saveIntake(state),
  });
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
