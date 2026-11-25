import { dirname, resolve } from 'node:path';

import PrivateStateFile from '../core/private-state-file.ts';
import { parseStorageConfig, type StorageBackend } from '../manifest/storage-schema.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import withWorkflowLock from './storage/workflow-lock.ts';

interface CodexConfiguration {
  storage?: unknown;
  cleanup?: unknown;
}

function codexConfigurationPath(pluginData: string) {
  return resolve(pluginData, 'instance', 'config.json');
}

function configurationFile(path: string) {
  return new PrivateStateFile({
    directories: [dirname(path)],
    currentUid: process.getuid?.(),
    label: 'Agent System installation configuration',
    maximumBytes: 64 * 1024,
    path,
  });
}

async function readConfiguration(file: PrivateStateFile): Promise<CodexConfiguration | undefined> {
  const source = await file.read();
  if (source === undefined) return;
  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch {
    throw new SyntaxError('Invalid Agent System JSON configuration in instance/config.json.');
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => key !== 'storage' && key !== 'cleanup')
  )
    throw new SyntaxError('Expected storage and cleanup settings in instance/config.json.');
  return config;
}

export function readCodexConfiguration(pluginData: string) {
  return readConfiguration(configurationFile(codexConfigurationPath(pluginData)));
}

export async function initializeCodexStorage(pluginData: string, backend: StorageBackend) {
  const path = codexConfigurationPath(pluginData);
  const file = configurationFile(path);
  const config = await readConfiguration(file);
  const saved = parseStorageConfig(config?.storage);
  if (saved) return saved;

  const withStorage = (current: CodexConfiguration = {}) =>
    JSON.stringify({ cleanup: {}, ...current, storage: { backend } }, null, 2) + '\n';
  if (config === undefined) {
    try {
      await file.create(withStorage());
      return backend;
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    }
  }

  // When a config already exists, fill in storage under the write lease so two
  // Install calls cannot both decide they own the installation storage setting.
  return withWorkflowLock(
    path,
    'Agent System installation configuration',
    async () => {
      const current = await readConfiguration(file);
      const selected = parseStorageConfig(current?.storage);
      if (selected) return selected;
      await file.write(withStorage(current));
      return backend;
    },
    { retries: { retries: 5, factor: 1, minTimeout: 25, maxTimeout: 25 } },
  );
}
