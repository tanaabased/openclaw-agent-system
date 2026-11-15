import { resolve } from 'node:path';

import discoverManifest, { discoverManifestAtPath } from './discover.ts';
import { loadDiscoveredManifest, type DiscoveredAgentManifestLoadResult } from './load.ts';

export type { AgentManifest, ManifestDiagnostic } from './types.ts';
export type { ResolvedAutomation } from './automation-schema.ts';
export type LoadManifestResult = DiscoveredAgentManifestLoadResult;

export interface LoadManifestOptions {
  workspaceDir: string;
  /** optional manifest path, absolute or relative to workspaceDir; no workspace discovery. */
  manifestPath?: string;
}

/** load definitions only: no runtime binding, credential resolution, setup or scheduling. */
export async function loadManifest(options: LoadManifestOptions): Promise<LoadManifestResult> {
  const workspaceDir = resolve(options.workspaceDir);
  const discovery =
    options.manifestPath === undefined
      ? await discoverManifest(workspaceDir)
      : await discoverManifestAtPath(workspaceDir, resolve(workspaceDir, options.manifestPath));
  return loadDiscoveredManifest(discovery);
}
