/** Project an inline Agent System setting from OpenClaw configuration. */
export function pluginSetting(config: unknown, name: string): unknown {
  let value = config;
  for (const key of ['plugins', 'entries', 'agent-system', 'config', name]) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value) || '$include' in value)
      throw new Error('Invalid Agent System configuration for ' + name);
    value = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}
