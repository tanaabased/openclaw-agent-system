import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';

// 10.10 async reads reuse pinned snapshots; child config writes need an unpinned reload.
/** reload config from disk after child openclaw commands mutate it outside this process. */
export default function readFreshRuntimeConfig(
  loadConfig: typeof getRuntimeConfig = getRuntimeConfig,
): OpenClawConfig {
  return loadConfig({ pin: false });
}
