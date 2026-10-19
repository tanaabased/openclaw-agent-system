import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import configuredAgentEntries from '../core/configured-agents.ts';

/** Reapply only a verified saved revision containing the missing registration. */
export default function gatewayAgentReapply(agentId: string, value: unknown) {
  const snapshot = value as {
    valid?: boolean;
    hash?: string;
    configRevisionHash?: string;
    appliedConfigHash?: string;
    config?: OpenClawConfig;
  } | null;
  if (
    snapshot?.valid !== true ||
    typeof snapshot.hash !== 'string' ||
    !snapshot.hash ||
    typeof snapshot.configRevisionHash !== 'string' ||
    typeof snapshot.appliedConfigHash !== 'string' ||
    !snapshot.config ||
    !configuredAgentEntries(snapshot.config).some((agent) => agent.id === agentId)
  )
    return { status: 'config-unverified' as const };
  if (snapshot.config.gateway?.reload?.mode === 'off')
    return { status: 'reload-disabled' as const };
  if (snapshot.configRevisionHash === snapshot.appliedConfigHash)
    return { status: 'already-applied' as const };
  // An unchanged patch is a no-op; apply republishes the snapshot to the native reload owner.
  return {
    status: 'prepared' as const,
    params: { baseHash: snapshot.hash, raw: JSON.stringify(snapshot.config) },
  };
}
