import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { readConfigFileSnapshotForWrite } from 'openclaw/plugin-sdk/config-mutation';

import { AgentSystemLifecycleError } from './lifecycle-registry.ts';

/** inspect saved desired state without publishing it as the active runtime configuration. */
export default async function readLifecycleConfig(
  readSnapshot: typeof readConfigFileSnapshotForWrite = readConfigFileSnapshotForWrite,
): Promise<OpenClawConfig> {
  const { snapshot } = await readSnapshot({ observe: false });
  if (!snapshot.valid) {
    throw new AgentSystemLifecycleError(
      'config',
      'openclaw-config-invalid',
      'OpenClaw configuration could not be read as valid saved state. Inspect it with OpenClaw Doctor before retrying.',
    );
  }
  return snapshot.runtimeConfig;
}
