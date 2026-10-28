import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

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

/** standalone runtimes share the default without reading host configuration. */
export default async function cleanupConfiguration(): Promise<CleanupConfiguration> {
  return parseCleanupConfiguration();
}

export async function openClawCleanupConfiguration(
  readConfig: () => OpenClawConfig,
): Promise<CleanupConfiguration> {
  try {
    return parseCleanupConfiguration(
      readConfig().plugins?.entries?.['agent-system']?.config?.cleanup,
    );
  } catch {
    return { status: 'blocked', code: 'retirement-configuration-unavailable' };
  }
}

export function cleanupConfigurationDiagnostic(configuration: CleanupConfiguration): string {
  if (configuration.status === 'ready') return 'plugins.entries.agent-system.config.cleanup';
  return 'Inspect plugins.entries.agent-system.config.cleanup in OpenClaw configuration. Set graceMinutes to an integer from 0 through 43200, or omit cleanup to use 60 minutes. Cleanup remains pending.';
}
