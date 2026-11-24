import { AsyncLocalStorage } from 'node:async_hooks';
import readGlobalConfigurationSource, { pluginSetting } from '../global-configuration.ts';
import { readdir } from 'node:fs/promises';
import {
  configuredStorageBackend,
  defaultStorageBackend,
  bindIntakeStore,
  type StorageBackend,
} from './backend.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeScopeLocation,
} from '../../channels/github/intake/record-store.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexSidebarJournal from '../codex-sidebar-journal.ts';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';

// A native command and its nested workflow calls must use the same backend.
const selection = new AsyncLocalStorage<StorageBackend>();
export function codexStorageBackend(): StorageBackend {
  return selection.getStore() ?? defaultStorageBackend;
}

export async function withCodexStorageBackend<T>(run: () => Promise<T>): Promise<T> {
  const source = await readGlobalConfigurationSource();
  return selection.run(configuredStorageBackend(pluginSetting(source, 'storage')), run);
}

export default function codexStorageLocation(pluginData: string): SqliteInstallation {
  return {
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
  };
}

export async function codexSidebarJournal(
  pluginData: string,
  profile: string,
  name: string,
  backend = codexStorageBackend(),
) {
  const storage =
    backend === 'sqlite'
      ? (await import('./agent-database.ts')).bindSqliteInstallation(
          codexStorageLocation(pluginData),
        )
      : undefined;
  return new CodexSidebarJournal(pluginData, profile, name, storage);
}

export function codexPickupStore(
  pluginData: string,
  agentId: string,
  backend = codexStorageBackend(),
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
  const { sqliteAgentDatabases } = await import('./agent-database.ts');
  yield* sqliteAgentDatabases(codexStorageLocation(pluginData));
}

export async function* retainedIntakeCandidates(
  pluginData: string,
  backend: StorageBackend = codexStorageBackend(),
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
