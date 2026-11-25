import { bindInstallationStore, bindIntakeStore, listAgentStores } from './backend.ts';
import { IntakeError, intakeScopeLocation } from '../../channels/github/intake/record-store.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexSidebarJournal from '../codex-sidebar-journal.ts';
import { bindPickupStore } from './pickup-backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';
import { parseStorageConfig, type StorageBackend } from '../../manifest/storage-schema.ts';
import PrivateStateFile from '../../core/private-state-file.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';

function codexStorageSettings(pluginData: string) {
  const directory = resolve(pluginData, 'instance');
  return new PrivateStateFile({
    directories: [directory],
    currentUid: process.getuid?.(),
    label: 'Agent System storage configuration',
    maximumBytes: 64 * 1024,
    path: join(directory, 'storage.json'),
  });
}

async function readCodexStorageBackend(file: PrivateStateFile) {
  const source = await file.read();
  if (source === undefined) return;
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error('Invalid Agent System storage configuration in instance/storage.json.');
  }
  const backend = parseStorageConfig(config);
  if (!backend) throw new Error('Set storage.backend in instance/storage.json or remove the file.');
  return backend;
}

export async function initializeCodexStorage(pluginData: string, backend: StorageBackend) {
  const settings = codexStorageSettings(pluginData);
  const saved = await readCodexStorageBackend(settings);
  if (saved) return saved;
  try {
    await settings.create(JSON.stringify({ backend }, null, 2) + '\n');
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
  }
  const initialized = await readCodexStorageBackend(settings);
  if (!initialized) throw new Error('Codex did not retain the installation storage setting.');
  return initialized;
}

export default function codexStorageLocation(pluginData: string): SqliteInstallation {
  return {
    agentRoot: join(pluginData, 'agent-system-storage'),
    installationRoot: resolve(pluginData, 'instance'),
    schemaRoot: fileURLToPath(new URL('../../agent/storage/', import.meta.url)),
    readInstallationBackend: () => readCodexStorageBackend(codexStorageSettings(pluginData)),
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
