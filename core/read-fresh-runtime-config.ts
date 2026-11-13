import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';

// 11.3 async readers reuse pinned snapshots; child-process writes require an unpinned reload.
/** reload config from disk after child openclaw commands mutate it outside this process. */
export default function readFreshRuntimeConfig(
  loadConfig: typeof getRuntimeConfig = getRuntimeConfig,
): OpenClawConfig {
  return loadConfig({ pin: false });
}
