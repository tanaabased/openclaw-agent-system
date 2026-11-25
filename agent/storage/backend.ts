import IntakeRecordStore, {
  type intakeLocation,
} from '../../channels/github/intake/record-store.ts';
import type { BoundStorage, SqliteInstallation } from './storage-lifecycle.ts';
import type { StorageBackend } from '../../manifest/storage-schema.ts';

export const defaultStorageBackend: StorageBackend = { type: 'sqlite' };
const adapters = { sqlite: () => import('./sqlite-backend.ts') };

export async function openClawStorageFamilies(backend: StorageBackend) {
  return (await adapters[backend.type]()).openClawDatabaseFamilies;
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
  backend?: StorageBackend,
): Promise<BoundStorage['agent']> {
  return (await bindStorage(agentId, installation, backend)).agent;
}

export async function bindStorage(
  agentId: string,
  installation: SqliteInstallation | undefined,
  selected?: StorageBackend,
): Promise<BoundStorage> {
  if (!installation) throw new Error('Agent System requires runtime storage locations');
  const backend =
    selected ?? (await installation.readAgentBackend?.(agentId)) ?? defaultStorageBackend;
  const shared = await installationDatabase(installation);
  const agent = (await adapters[backend.type]()).bindAgent(installation, agentId, shared);
  return { agent, installation: shared };
}

export interface RuntimeStorageOptions {
  sqliteInstallation?: SqliteInstallation;
}

async function installationAdapter(location: SqliteInstallation, selected?: StorageBackend) {
  const backend = selected ?? (await location.readInstallationBackend?.()) ?? defaultStorageBackend;
  return adapters[backend.type]();
}

async function installationDatabase(location: SqliteInstallation, selected?: StorageBackend) {
  return (await installationAdapter(location, selected)).bindInstallation(location);
}

export async function bindInstallationStore(
  { sqliteInstallation }: RuntimeStorageOptions,
  backend?: StorageBackend,
): Promise<BoundStorage['installation']> {
  if (!sqliteInstallation) throw new Error('Agent System requires runtime storage locations');
  return installationDatabase(sqliteInstallation, backend);
}

export async function* listAgentStores(installation: SqliteInstallation | undefined) {
  if (!installation) throw new Error('Agent System requires runtime storage locations');
  const shared = await installationDatabase(installation);
  for (const loadAdapter of Object.values(adapters))
    yield* (await loadAdapter()).agentStores(installation, shared);
}

export async function storageProtectedPaths(
  { sqliteInstallation }: RuntimeStorageOptions,
  backend = defaultStorageBackend,
) {
  if (!sqliteInstallation) return [];
  const [agentAdapter, sharedAdapter] = await Promise.all([
    adapters[backend.type](),
    installationAdapter(sqliteInstallation),
  ]);
  return [
    agentAdapter.protectedAgentPath(sqliteInstallation),
    sharedAdapter.protectedInstallationPath(sqliteInstallation),
  ];
}

export async function openClawSnapshot({ sqliteInstallation }: RuntimeStorageOptions = {}) {
  // Existing embedded snapshots verify and restore using their SQLite archive format.
  const adapter = sqliteInstallation
    ? await installationAdapter(sqliteInstallation)
    : await adapters.sqlite();
  return adapter.openClawSnapshot;
}
