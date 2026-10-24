import { setupDefaultTimeoutSeconds } from '../manifest/setup-schema.ts';

// direct managed commands share the existing setup execution allowance; callers may own a tighter deadline.
export const managedCommandTimeoutMs = setupDefaultTimeoutSeconds * 1000;
export const metadataCommandTimeoutMs = 30_000;
export const commandTerminationGraceMs = 5_000;
