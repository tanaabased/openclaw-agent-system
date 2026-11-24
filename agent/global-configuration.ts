import { readFile } from 'node:fs/promises';

import JSON5 from 'json5';
import { resolveConfigPath } from 'openclaw/plugin-sdk/state-paths';

export interface GlobalConfigurationSource {
  env?: NodeJS.ProcessEnv;
  read?: (path: string) => Promise<string>;
}

/** read source only: never load host environment, secrets, plugins, or runtime state. */
export default async function readGlobalConfigurationSource(
  input: GlobalConfigurationSource = {},
): Promise<unknown> {
  const env = input.env ?? process.env;
  const path = resolveConfigPath(env);
  let source: string;
  try {
    source = await (input.read ?? ((file) => readFile(file, 'utf8')))(path);
  } catch (error) {
    // an explicitly selected missing file is unavailable, not an absent global policy.
    if (
      !env.OPENCLAW_CONFIG_PATH?.trim() &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return {};
    throw error;
  }
  return JSON5.parse(source) as unknown;
}

/** Project an inline Agent System setting without resolving unrelated host configuration. */
export function pluginSetting(config: unknown, name: string): unknown {
  let value = config;
  for (const key of ['plugins', 'entries', 'agent-system', 'config', name]) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) || '$include' in value)
      throw new Error('Invalid Agent System configuration for ' + name);
    value = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}
