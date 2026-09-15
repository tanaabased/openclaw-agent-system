import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export const memorySecretProviderAlias = 'agent-system-environment';
export const memorySecretProviderIntegrationId = 'environment';

const memorySecretProviderEntrypoint = 'memory-secret-provider-entry.js';
const memorySecretProviderPassEnv = [
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'OPENAI_API_KEY',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_STATE_DIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
] as const;

type SecretProviders = NonNullable<NonNullable<OpenClawConfig['secrets']>['providers']>;
export type MemorySecretProviderConfiguration = SecretProviders[string];

const pluginIntegrationConfiguration: MemorySecretProviderConfiguration = {
  source: 'exec',
  pluginIntegration: {
    pluginId: 'agent-system',
    integrationId: memorySecretProviderIntegrationId,
  },
};

function isSecurePathStat(stat: Stats): boolean {
  if (process.platform === 'win32') return true;
  if ((stat.mode & 0o022) !== 0) return false;
  if (typeof process.getuid !== 'function') return true;
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  const sourceStat = lstatSync(path);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`${label} must be a secure regular directory.`);
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isSecurePathStat(stat)) {
    throw new Error(`${label} must be a secure regular directory.`);
  }
  return canonical;
}

function canonicalFile(
  path: string,
  label: string,
  options: { executable?: boolean; rejectHardlinks?: boolean } = {},
): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  const sourceStat = lstatSync(path);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`${label} must be a secure regular file.`);
  }
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !isSecurePathStat(stat) ||
    (options.rejectHardlinks && stat.nlink > 1) ||
    (options.executable && process.platform !== 'win32' && (stat.mode & 0o111) === 0)
  ) {
    throw new Error(`${label} must be a secure regular file.`);
  }
  return canonical;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function isConfiguredLoadPath(config: OpenClawConfig, packageDir: string): boolean {
  return (config.plugins?.load?.paths ?? []).some((path) => {
    if (!isAbsolute(path)) return false;
    try {
      return realpathSync(path) === packageDir;
    } catch {
      return false;
    }
  });
}

function standaloneConfiguration(
  command: string,
  entrypoint: string,
  packageDir: string,
): MemorySecretProviderConfiguration {
  return {
    source: 'exec',
    command,
    args: [entrypoint],
    timeoutMs: 90_000,
    noOutputTimeoutMs: 90_000,
    maxOutputBytes: 1024 * 1024,
    jsonOnly: true,
    passEnv: [...memorySecretProviderPassEnv],
    trustedDirs: [dirname(command), packageDir],
  };
}

function isStandaloneConfiguration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = Reflect.get(value, 'command');
  const args = Reflect.get(value, 'args');
  if (
    Reflect.get(value, 'source') !== 'exec' ||
    typeof command !== 'string' ||
    !isAbsolute(command) ||
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== 'string' ||
    !isAbsolute(args[0]) ||
    dirname(args[0]).split(sep).at(-1) !== 'dist' ||
    args[0].split(sep).at(-1) !== memorySecretProviderEntrypoint
  ) {
    return false;
  }
  const packageDir = dirname(dirname(args[0]));
  return isDeepStrictEqual(value, standaloneConfiguration(command, args[0], packageDir));
}

export function memorySecretId(agentId: string, binding: string): string {
  return `agents/${agentId}/environment/${binding}`;
}

/** Recognize only the two complete provider forms owned by Agent System. */
export function isAgentSystemMemorySecretProvider(value: unknown): boolean {
  return (
    isDeepStrictEqual(value, pluginIntegrationConfiguration) || isStandaloneConfiguration(value)
  );
}

/** Select a trusted provider form for the active package installation. */
export function createMemorySecretProviderConfiguration(params: {
  config: OpenClawConfig;
  nodeExecutable: string;
  packageDir: string;
}): MemorySecretProviderConfiguration {
  const packageDir = realpathSync(params.packageDir);
  if (!isConfiguredLoadPath(params.config, packageDir)) {
    return structuredClone(pluginIntegrationConfiguration);
  }

  const trustedPackageDir = canonicalDirectory(packageDir, 'Agent System package directory');
  const nodeExecutable = canonicalFile(realpathSync(params.nodeExecutable), 'Node.js executable', {
    executable: true,
  });
  const distDir = canonicalDirectory(
    join(trustedPackageDir, 'dist'),
    'Agent System dist directory',
  );
  const entrypoint = canonicalFile(
    join(distDir, memorySecretProviderEntrypoint),
    'Agent System memory secret-provider entrypoint',
    { rejectHardlinks: process.platform !== 'win32' },
  );
  if (!isInside(trustedPackageDir, entrypoint)) {
    throw new Error(
      'Agent System memory secret-provider entrypoint escaped the package directory.',
    );
  }
  return standaloneConfiguration(nodeExecutable, entrypoint, trustedPackageDir);
}
