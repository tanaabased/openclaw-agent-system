import type { AgentManifest } from './manifest-types.ts';

export interface OpEnvironmentSecretRequirement {
  name: string;
  reference: string;
}

export interface OpEnvironmentRequirements {
  environmentIds: string[];
  secrets: OpEnvironmentSecretRequirement[];
}

/** Collect only declared OP resources without resolving or exposing their values. */
export default function collectOpEnvironmentRequirements(
  manifest: AgentManifest,
): OpEnvironmentRequirements {
  return {
    environmentIds: [...(manifest.environment?.op ?? [])],
    secrets: Object.entries(manifest.environment?.set ?? {}).flatMap(([name, value]) =>
      typeof value === 'string' || name === 'OP_SERVICE_ACCOUNT_TOKEN'
        ? []
        : [{ name, reference: value.fromOp }],
    ),
  };
}

export function hasOpEnvironmentRequirements(requirements: OpEnvironmentRequirements): boolean {
  return requirements.environmentIds.length > 0 || requirements.secrets.length > 0;
}
