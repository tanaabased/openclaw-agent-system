import { bindInstallationStore, bindIntakeStore, listAgentStores } from './backend.ts';
import { IntakeError, intakeScopeLocation } from '../../channels/github/intake/record-store.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexSidebarJournal from '../codex-sidebar-journal.ts';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';
import { parseStorageConfig, type StorageBackend } from '../../manifest/storage-schema.ts';
import { readCodexConfiguration } from '../codex-configuration.ts';

export default function codexStorageLocation(pluginData: string): SqliteInstallation {
  return {
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
    readInstallationBackend: async () =>
      parseStorageConfig((await readCodexConfiguration(pluginData))?.storage),
  };
}

export async function codexSidebarJournal(pluginData: string, profile: string, name: string) {
  return new CodexSidebarJournal(
    profile,
    name,
    await bindInstallationStore({ sqliteInstallation: codexStorageLocation(pluginData) }),
  );
}

export function codexPickupStore(pluginData: string, agentId: string, backend?: StorageBackend) {
  return bindPickupStore(codexStorageLocation(pluginData), agentId, backend);
}

export function codexAgentDatabases(pluginData: string) {
  return listAgentStores(codexStorageLocation(pluginData));
}

export async function* retainedIntakeCandidates(pluginData: string) {
  for await (const { agentId, agent } of codexAgentDatabases(pluginData)) {
    for (const scope of await agent.listIntakeScopes()) {
      if (!/^[a-f0-9]{64}$/u.test(scope)) throw new IntakeError('intake-state-invalid');
      yield { agentId, store: bindIntakeStore(intakeScopeLocation(pluginData, scope), agent) };
    }
  }
}
