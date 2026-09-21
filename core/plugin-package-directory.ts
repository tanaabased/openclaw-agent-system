import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the installed package root independently of OpenClaw's generated runtime artifact. */
export default function resolvePluginPackageDirectory(
  rootDir: string | undefined,
  runtimeUrl: string,
): string {
  if (rootDir) return rootDir;
  const runtimeDir = dirname(fileURLToPath(runtimeUrl));
  return basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
}
