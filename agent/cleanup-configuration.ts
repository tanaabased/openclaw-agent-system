import readInstallationConfig, { type InstallationConfig } from '../core/installation-config.ts';

export type CleanupConfiguration = InstallationConfig;
export { readInstallationConfig as default };

export function cleanupConfigurationDiagnostic(configuration: CleanupConfiguration): string {
  if (configuration.status === 'ready') return configuration.path;
  const location = configuration.path ?? 'host XDG_CONFIG_HOME or HOME configuration root';
  return `Inspect ${location}; restore a readable, private regular file with schema-version: 1 and cleanup.grace-minutes (integer 0..43200), or deliberately remove it to use 60 minutes. Cleanup remains pending.`;
}
