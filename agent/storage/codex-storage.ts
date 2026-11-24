import { readdir } from 'node:fs/promises';
import { defaultStorageBackend, bindIntakeStore, type StorageBackend } from './backend.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeScopeLocation,
} from '../../channels/github/intake/record-store.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';

export default function codexStorageLocation(pluginData: string): SqliteInstallation {
  return {
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
  };
}

export function codexPickupStore(
  pluginData: string,
  agentId: string,
  backend = defaultStorageBackend,
) {
  return bindPickupStore(codexStorageLocation(pluginData), agentId, backend);
}

async function storageNames(directory: string) {
  return readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
}

export async function* codexAgentDatabases(pluginData: string) {
  const installation = codexStorageLocation(pluginData);
  const { bindSqliteStorage } = await import('./agent-database.ts');
  for (const name of await storageNames(installation.agentRoot)) {
    const match = /^([a-z0-9][a-z0-9-]*)\.sqlite$/u.exec(name);
    if (match) {
      const agentId = match[1]!;
      yield { agentId, agent: bindSqliteStorage(installation, agentId).agent };
    }
  }
}

export async function* retainedIntakeCandidates(
  pluginData: string,
  backend: StorageBackend = defaultStorageBackend,
) {
  if (backend === 'file') {
    const names = await storageNames(pluginData);
    if (names.length > 2000) throw new IntakeError('intake-state-invalid');
    for (const name of names) {
      const match = /^github-intake-([a-f0-9]{64})\.json$/u.exec(name);
      if (match) yield { store: new IntakeRecordStore(intakeScopeLocation(pluginData, match[1]!)) };
    }
    return;
  }
  for await (const { agentId, agent } of codexAgentDatabases(pluginData)) {
    for (const scope of await agent.listIntakeScopes()) {
      if (!/^[a-f0-9]{64}$/u.test(scope)) throw new IntakeError('intake-state-invalid');
      yield { agentId, store: bindIntakeStore(intakeScopeLocation(pluginData, scope), agent) };
    }
  }
}
