import readInstallationConfig, { type InstallationConfig } from '../core/installation-config.ts';
import type { AgentManifest } from '../manifest/types.ts';

export type CleanupConfiguration =
  | InstallationConfig
  | {
      status: 'blocked';
      code: 'retirement-cleanup-migration-required';
      path?: string;
      effectiveGraceMinutes?: number;
      legacy: NonNullable<AgentManifest['cleanupMigration']>;
    };

export default async function cleanupConfiguration(
  manifest: AgentManifest,
  read = readInstallationConfig,
): Promise<CleanupConfiguration> {
  const settings = await read();
  return manifest.cleanupMigration
    ? {
        status: 'blocked',
        code: 'retirement-cleanup-migration-required',
        path: settings.path,
        ...(settings.status === 'ready' ? { effectiveGraceMinutes: settings.graceMinutes } : {}),
        legacy: manifest.cleanupMigration,
      }
    : settings;
}

export function cleanupConfigurationDiagnostic(configuration: CleanupConfiguration): string {
  if (configuration.status === 'ready') return configuration.path;
  const location = configuration.path ?? 'host XDG_CONFIG_HOME or HOME configuration root';
  if ('legacy' in configuration)
    return `Remove github.notifications.cleanup from ${configuration.legacy.sources?.map(({ sourcePath, fieldPath }) => `${sourcePath}:${fieldPath}`).join(', ') || configuration.legacy.sourcePath || 'agent.yaml and overlays'} after choosing cleanup.grace-minutes in ${location} (effective: ${configuration.effectiveGraceMinutes ?? 'unavailable'}). Old declaration: ${JSON.stringify(configuration.legacy.declaration)}. Removing enabled: false opts this agent into safe automatic cleanup.`;
  return `Inspect ${location}; restore a readable, private regular file with schema-version: 1 and cleanup.grace-minutes (integer 0..43200), or deliberately remove it to use 60 minutes. Cleanup remains pending.`;
}
