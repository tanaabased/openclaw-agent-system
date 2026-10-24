import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export type ConfiguredAgentEntry = ConfiguredAgentValue & { id: string };
export type ConfiguredAgentValue = NonNullable<
  NonNullable<OpenClawConfig['agents']>['entries']
>[string];

function isAgentValue(value: unknown): value is ConfiguredAgentValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** read canonical keyed agents, retaining the legacy runtime projection while openclaw supports it. */
export default function configuredAgentEntries(config: OpenClawConfig): ConfiguredAgentEntry[] {
  const keyedEntries = config.agents?.entries;
  if (keyedEntries && isAgentValue(keyedEntries)) {
    return Object.entries(keyedEntries).flatMap(([id, entry]) =>
      isAgentValue(entry) ? [{ ...entry, id }] : [],
    );
  }

  const projectedEntries: unknown = Reflect.get(config.agents ?? {}, 'list');
  if (!Array.isArray(projectedEntries)) return [];
  return projectedEntries.filter(
    (entry): entry is ConfiguredAgentEntry =>
      isAgentValue(entry) && 'id' in entry && typeof entry.id === 'string',
  );
}

/** resolve the mutable source entry used by config-file reconciliation. */
export function configuredAgentValue(
  config: OpenClawConfig,
  agentId: string,
): ConfiguredAgentValue | ConfiguredAgentEntry | undefined {
  const normalizedAgentId = agentId.trim().toLowerCase();
  const keyedEntries = config.agents?.entries;
  if (keyedEntries && isAgentValue(keyedEntries)) {
    const match = Object.entries(keyedEntries).find(
      ([id, entry]) => id.trim().toLowerCase() === normalizedAgentId && isAgentValue(entry),
    );
    return match?.[1];
  }
  return configuredAgentEntries(config).find(
    (entry) => entry.id.trim().toLowerCase() === normalizedAgentId,
  );
}
