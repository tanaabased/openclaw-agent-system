import readGlobalConfigurationSource, { pluginSetting } from '../global-configuration.ts';
import { validateStorageConfig, bindIntakeStore } from './backend.ts';
import { IntakeError, intakeScopeLocation } from '../../channels/github/intake/record-store.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexSidebarJournal from '../codex-sidebar-journal.ts';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';

export async function validateCodexStorageConfig() {
  const source = await readGlobalConfigurationSource();
  validateStorageConfig(pluginSetting(source, 'storage'));
}

export default function codexStorageLocation(pluginData: string): SqliteInstallation {
  return {
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
  };
}

export async function codexSidebarJournal(pluginData: string, profile: string, name: string) {
  const { bindSqliteInstallation } = await import('./agent-database.ts');
  return new CodexSidebarJournal(
    profile,
    name,
    bindSqliteInstallation(codexStorageLocation(pluginData)),
  );
}

export function codexPickupStore(pluginData: string, agentId: string) {
  return bindPickupStore(codexStorageLocation(pluginData), agentId);
}

export async function* codexAgentDatabases(pluginData: string) {
  const { sqliteAgentDatabases } = await import('./agent-database.ts');
  yield* sqliteAgentDatabases(codexStorageLocation(pluginData));
}

export async function* retainedIntakeCandidates(pluginData: string) {
  for await (const { agentId, agent } of codexAgentDatabases(pluginData)) {
    for (const scope of await agent.listIntakeScopes()) {
      if (!/^[a-f0-9]{64}$/u.test(scope)) throw new IntakeError('intake-state-invalid');
      yield { agentId, store: bindIntakeStore(intakeScopeLocation(pluginData, scope), agent) };
    }
  }
}
