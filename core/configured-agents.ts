import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export type ConfiguredAgentEntry = NonNullable<
  NonNullable<OpenClawConfig['agents']>['list']
>[number];
export type ConfiguredAgentValue = NonNullable<
  NonNullable<OpenClawConfig['agents']>['entries']
>[string];

function isAgentValue(value: unknown): value is ConfiguredAgentValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read canonical keyed agents, with the validated list projection as a compatibility fallback. */
export default function configuredAgentEntries(config: OpenClawConfig): ConfiguredAgentEntry[] {
  const keyedEntries = config.agents?.entries;
  if (keyedEntries && isAgentValue(keyedEntries)) {
    return Object.entries(keyedEntries).flatMap(([id, entry]) =>
      isAgentValue(entry) ? [{ ...entry, id }] : [],
    );
  }

  const projectedEntries = config.agents?.list;
  if (!Array.isArray(projectedEntries)) return [];
  return projectedEntries.filter(
    (entry): entry is ConfiguredAgentEntry => isAgentValue(entry) && typeof entry.id === 'string',
  );
}

/** Resolve the mutable source entry used by config-file reconciliation. */
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
  return config.agents?.list?.find((entry) => entry.id.trim().toLowerCase() === normalizedAgentId);
}
