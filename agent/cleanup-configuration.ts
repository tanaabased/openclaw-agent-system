import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import readCleanupConfigurationSource, {
  type CleanupConfigurationSource,
} from './cleanup-configuration-source.ts';

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
  let value = config;
  for (const key of ['plugins', 'entries', 'agent-system', 'config', 'cleanup']) {
    if (value === undefined) return parseCleanupConfiguration();
    if (!value || typeof value !== 'object' || Array.isArray(value) || '$include' in value)
      return { status: 'blocked', code: 'retirement-configuration-invalid' };
    value = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return parseCleanupConfiguration(value);
}

export default async function cleanupConfiguration(
  source: CleanupConfigurationSource = {},
): Promise<CleanupConfiguration> {
  try {
    return projectCleanupConfiguration(await readCleanupConfigurationSource(source));
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

export function cleanupConfigurationDiagnostic(configuration: CleanupConfiguration): string {
  if (configuration.status === 'ready') return 'plugins.entries.agent-system.config.cleanup';
  return 'Inspect plugins.entries.agent-system.config.cleanup in OpenClaw configuration. Set graceMinutes to an integer from 0 through 43200, or omit cleanup to use 60 minutes. Standalone Codex requires this policy inline, without $include on its configuration path. Cleanup remains pending.';
}
