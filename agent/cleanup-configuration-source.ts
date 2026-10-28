import { readFile } from 'node:fs/promises';

import JSON5 from 'json5';
import { resolveConfigPath } from 'openclaw/plugin-sdk/state-paths';

export interface CleanupConfigurationSource {
  env?: NodeJS.ProcessEnv;
  read?: (path: string) => Promise<string>;
}

/** read source only: never load host environment, secrets, plugins, or runtime state. */
export default async function readCleanupConfigurationSource(
  input: CleanupConfigurationSource = {},
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
