import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export type ConfiguredAgentEntry = NonNullable<
  NonNullable<OpenClawConfig['agents']>['list']
>[number];

/** Read valid configured agent objects without depending on OpenClaw's broad agent barrel. */
export default function configuredAgentEntries(config: OpenClawConfig): ConfiguredAgentEntry[] {
  const entries = config.agents?.list;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is ConfiguredAgentEntry =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

/** List unique configured ids with OpenClaw's implicit main-agent fallback. */
export function configuredAgentIds(config: OpenClawConfig): string[] {
  const ids = configuredAgentEntries(config).map(({ id }) => id.trim().toLowerCase());
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  return uniqueIds.length > 0 ? uniqueIds : ['main'];
}
