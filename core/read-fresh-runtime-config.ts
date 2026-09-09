import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';

/** Reload config from disk after child OpenClaw commands mutate it outside this process. */
export default function readFreshRuntimeConfig(
  loadConfig: typeof getRuntimeConfig = getRuntimeConfig,
): OpenClawConfig {
  return loadConfig({ pin: false });
}
