import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { readConfigFileSnapshotForWrite } from 'openclaw/plugin-sdk/config-mutation';

import type { AgentSystemLifecycleContribution } from '../../core/lifecycle-registry.ts';
import { parseStorageConfig, type StorageBackend } from '../../manifest/storage-schema.ts';
import { defaultStorageBackend, openClawStorageFamilies } from './backend.ts';

type Family = 'state' | 'agent';

interface OpenClawStorageDependencies {
  readConfig(): Promise<OpenClawConfig>;
  mutateConfigFile(params: {
    base: 'source';
    afterWrite: { mode: 'auto' };
    mutate(config: OpenClawConfig): boolean;
  }): Promise<{ result: boolean | undefined; nextConfig: OpenClawConfig }>;
  readRuntimeConfig(): OpenClawConfig;
}

export function openClawInstallationBackend(config: OpenClawConfig) {
  return parseStorageConfig(config.plugins?.entries?.['agent-system']?.config?.storage);
}

export async function readOpenClawStorageConfig(): Promise<OpenClawConfig> {
  const { snapshot } = await readConfigFileSnapshotForWrite({ observe: false });
  if (!snapshot.valid) throw new Error('OpenClaw storage configuration is unavailable.');
  return snapshot.sourceConfig;
}

export async function initializeOpenClawStorage(
  dependencies: OpenClawStorageDependencies,
  backend: StorageBackend,
) {
  const saved = openClawInstallationBackend(await dependencies.readConfig());
  if (saved) return saved;
  const mutation = await dependencies.mutateConfigFile({
    base: 'source',
    afterWrite: { mode: 'auto' },
    mutate(config) {
      if (openClawInstallationBackend(config)) return false;
      config.plugins ??= {};
      config.plugins.entries ??= {};
      const entry = (config.plugins.entries['agent-system'] ??= {});
      entry.config ??= {};
      entry.config.storage = { backend };
      return true;
    },
  });
  const initialized = openClawInstallationBackend(mutation.nextConfig);
  if (!initialized) throw new Error('OpenClaw did not retain the installation storage setting.');
  return initialized;
}

/** The backend chooses the targets. Only this host integration observes and changes host config. */
export function openClawStorageLifecycle(
  dependencies: OpenClawStorageDependencies,
): AgentSystemLifecycleContribution {
  const families = ['state', 'agent'] as const;
  const engine = (config: OpenClawConfig, family: Family) =>
    config.database?.families?.[family]?.engine ?? config.database?.engine ?? 'sqlite';
  const changeRequired = (
    saved: OpenClawConfig,
    runtime: OpenClawConfig,
    family: Family,
    desired: string,
  ) => engine(saved, family) !== desired || engine(runtime, family) !== desired;
  const remediation = 'Use the supported OpenClaw database port and restart the Gateway.';

  return {
    id: 'openclaw-storage',
    isConfigured: () => true,
    async inspect({ manifest }) {
      const config = await dependencies.readConfig();
      const runtime = dependencies.readRuntimeConfig();
      const desired = await openClawStorageFamilies(
        openClawInstallationBackend(config) ?? manifest.storage?.backend ?? defaultStorageBackend,
      );
      return families.map((family) => {
        const drift = changeRequired(config, runtime, family, desired[family]);
        const label = family === 'agent' ? 'agent (including enabled built-in memory)' : 'state';
        return {
          code: `openclaw-storage-${family}-${drift ? 'drift' : 'ready'}`,
          status: drift ? 'drift' : 'healthy',
          message: drift
            ? `OpenClaw ${label} storage expects ${desired[family]}, with ${engine(config, family)} saved and ${engine(runtime, family)} in the runtime config.`
            : `OpenClaw ${label} storage is configured for ${desired[family]}.`,
          ...(drift ? { remediation } : {}),
        };
      });
    },
    async reconcile() {
      const config = await dependencies.readConfig();
      const desired = await openClawStorageFamilies(
        openClawInstallationBackend(config) ?? defaultStorageBackend,
      );
      const hasDrift = (input: OpenClawConfig) => {
        const runtime = dependencies.readRuntimeConfig();
        return families.some((family) => changeRequired(input, runtime, family, desired[family]));
      };
      const warning = {
        code: 'openclaw-storage-port-required',
        message: `OpenClaw storage settings were preserved. ${remediation}`,
      };
      if (hasDrift(config)) return { outcomes: [], warnings: [warning] };

      // Keep OpenClaw's implicit SQLite defaults. Pin compatible families when an
      // explicit host-wide engine is set so an edit for other families cannot move ours.
      const needsProjection = (input: OpenClawConfig) =>
        input.database?.engine !== undefined &&
        families.some((family) => input.database?.families?.[family] === undefined);
      if (!needsProjection(config)) return { outcomes: [] };
      const mutation = await dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(draft) {
          if (hasDrift(draft) || !needsProjection(draft)) return false;
          const database = (draft.database ??= {});
          const overrides = (database.families ??= {});
          for (const family of families) overrides[family] ??= { engine: desired[family] };
          return true;
        },
      });
      return {
        outcomes: mutation.result
          ? [
              {
                code: 'openclaw-storage-projected',
                status: 'updated',
                message: 'OpenClaw storage families configured.',
              },
            ]
          : [],
        ...(hasDrift(mutation.nextConfig) ? { warnings: [warning] } : {}),
      };
    },
  };
}
