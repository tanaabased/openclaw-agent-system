import { join, resolve } from 'node:path';

import type { AgentManifest } from '../manifest/types.ts';
import { resolveToolExecutable } from './cli-runner.ts';

export interface ExecutableRequirementDefinition<TConfiguration> {
  requiredExecutables?(configuration: TConfiguration): readonly string[];
  runner?: { executable: string };
}

/** Include a CLI tool's primary executable and deduplicate additional declarations. */
export function requiredToolExecutables<TConfiguration>(
  definition: ExecutableRequirementDefinition<TConfiguration>,
  configuration: TConfiguration,
): string[] {
  return [
    ...new Set([
      ...(definition.runner ? [definition.runner.executable] : []),
      ...(definition.requiredExecutables?.(configuration) ?? []),
    ]),
  ];
}

/** Keep the executable search exclusions identical to managed CLI execution. */
export function excludedToolExecutableDirectories(
  manifest: AgentManifest,
  workspaceDir: string,
  excludedDirectories: readonly string[] = [],
): string[] {
  return [
    join(workspaceDir, 'bin'),
    ...(manifest.environment?.pathPrepend ?? []).map((path) => resolve(workspaceDir, path)),
    ...excludedDirectories,
  ];
}

/** Read only host executable metadata; never launch commands or retain a cache. */
export async function unavailableToolExecutables(
  names: readonly string[],
  path: string,
  excludedDirectories: readonly string[],
  resolveExecutable: typeof resolveToolExecutable = resolveToolExecutable,
): Promise<string[]> {
  const unavailable: string[] = [];
  for (const name of new Set(names)) {
    try {
      await resolveExecutable(name, path, excludedDirectories);
    } catch {
      unavailable.push(name);
    }
  }
  return unavailable;
}

export function executableGuidance(tool: string, unavailable: readonly string[]): string {
  return `The ${tool} tool requires unavailable executables: ${unavailable.join(', ')}. Install them on the host and make them available on the runtime PATH.`;
}
