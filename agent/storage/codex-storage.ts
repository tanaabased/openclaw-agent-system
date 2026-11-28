import { bindInstallationStore } from './backend.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexSidebarJournal from '../codex-sidebar-journal.ts';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import { readBoundCodexWorkspace } from '../identity/codex-workspace-binding.ts';

export function codexStoragePaths(pluginData: string) {
  return {
    migrateCodexSchedules: true,
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
  };
}

export default function codexStorageLocation(
  pluginData: string,
  manifest?: AgentManifest,
): SqliteInstallation {
  const backend = async () =>
    (manifest ?? (await readBoundCodexWorkspace(pluginData)).loaded.manifest).storage?.backend;
  return {
    ...codexStoragePaths(pluginData),
    readInstallationBackend: backend,
    readAgentBackend: backend,
  };
}

export async function codexSidebarJournal(pluginData: string, profile: string, name: string) {
  return new CodexSidebarJournal(
    profile,
    name,
    await bindInstallationStore({ sqliteInstallation: codexStorageLocation(pluginData) }),
  );
}

export async function codexPickupStore(pluginData: string, bound?: AgentManifest) {
  const manifest = bound ?? (await readBoundCodexWorkspace(pluginData)).loaded.manifest;
  return bindPickupStore(
    codexStorageLocation(pluginData, manifest),
    manifest.agent.id,
    manifest.storage?.backend,
  );
}
