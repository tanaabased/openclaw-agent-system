import { dirname, resolve } from 'node:path';

import PrivateStateFile from '../core/private-state-file.ts';
import { parseStorageConfig } from '../manifest/storage-schema.ts';
import withWorkflowLock from './storage/workflow-lock.ts';

interface CodexConfiguration {
  // Retired fields are accepted only for the in-place upgrade.
  onePassword?: unknown;
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
    Object.keys(config).some(
      (key) => key !== 'storage' && key !== 'cleanup' && key !== 'onePassword',
    )
  )
    throw new SyntaxError('Unrecognized setting in instance/config.json.');
  return config;
}

export function readCodexConfiguration(pluginData: string) {
  return readConfiguration(configurationFile(codexConfigurationPath(pluginData)));
}

export async function upgradeCodexConfiguration(pluginData: string) {
  const path = codexConfigurationPath(pluginData);
  const file = configurationFile(path);
  const config = await readConfiguration(file);
  if (!config || (!('storage' in config) && !('onePassword' in config))) return;
  await withWorkflowLock(
    path,
    'Agent System installation configuration',
    async () => {
      const current = await readConfiguration(file);
      if (!current || (!('storage' in current) && !('onePassword' in current))) return;
      // Keep the existing pre-SQLite import safeguard before discarding the old setting.
      parseStorageConfig(current.storage);
      delete current.storage;
      delete current.onePassword;
      await file.write(JSON.stringify(current, null, 2) + '\n');
    },
    { retries: { retries: 5, factor: 1, minTimeout: 25, maxTimeout: 25 } },
  );
}
