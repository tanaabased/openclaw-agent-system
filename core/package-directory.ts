import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

/** Prefer the host's discovered package root over a loader-transformed module location. */
export default function resolvePackageDirectory(
  api: Pick<OpenClawPluginApi, 'rootDir'>,
  runtimeUrl: string,
): string {
  if (api.rootDir) return api.rootDir;
  const runtimeDir = dirname(fileURLToPath(runtimeUrl));
  return basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
}
