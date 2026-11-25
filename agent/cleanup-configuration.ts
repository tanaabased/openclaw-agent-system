import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readCodexConfiguration } from './codex-configuration.ts';
import { pluginSetting } from './global-configuration.ts';

export const defaultCleanupGraceMinutes = 60;

const schema = Type.Object(
  { graceMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 43_200 })) },
  { additionalProperties: false },
);

export type CleanupConfiguration =
  | { status: 'ready'; graceMinutes: number; digest: string }
  | {
      status: 'blocked';
      code: 'retirement-configuration-unavailable' | 'retirement-configuration-invalid';
    };

export function parseCleanupConfiguration(value?: unknown): CleanupConfiguration {
  const settings = value === undefined ? {} : value;
  if (!Value.Check(schema, settings))
    return { status: 'blocked', code: 'retirement-configuration-invalid' };
  const graceMinutes = settings.graceMinutes ?? defaultCleanupGraceMinutes;
  return { status: 'ready', graceMinutes, digest: `cleanup:${graceMinutes}` };
}

/** project only the shared cleanup policy; unresolved source includes must not look absent. */
export function projectCleanupConfiguration(config: unknown): CleanupConfiguration {
  try {
    return parseCleanupConfiguration(pluginSetting(config, 'cleanup'));
  } catch {
    return { status: 'blocked', code: 'retirement-configuration-invalid' };
  }
}

export async function codexCleanupConfiguration(pluginData: string): Promise<CleanupConfiguration> {
  try {
    return parseCleanupConfiguration((await readCodexConfiguration(pluginData))?.cleanup);
  } catch (error) {
    return {
      status: 'blocked',
      code:
        error instanceof SyntaxError
          ? 'retirement-configuration-invalid'
          : 'retirement-configuration-unavailable',
    };
  }
}

export async function openClawCleanupConfiguration(
  readConfig: () => OpenClawConfig,
): Promise<CleanupConfiguration> {
  try {
    return projectCleanupConfiguration(readConfig());
  } catch {
    return { status: 'blocked', code: 'retirement-configuration-unavailable' };
  }
}

export function cleanupConfigurationDiagnostic(
  setting = 'cleanup.graceMinutes in the Agent System installation configuration',
) {
  return `Check ${setting}. Set an integer from 0 through 43200 or omit it to use 60 minutes.`;
}

export const codexCleanupConfigurationDiagnostic = cleanupConfigurationDiagnostic(
  'cleanup.graceMinutes in instance/config.json',
);
