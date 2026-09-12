import { resolve } from 'node:path';

import OpCache from './op-cache.ts';

const registryKey = Symbol.for('@tanaab/agent-system/op-process-cache/v1');
const maximumInstallations = 16;
type CacheRegistry = Map<string, OpCache>;

/** Share values across plugin registry loads, never across installations or processes. */
export default function processOpCache(scope: {
  packageDir: string;
  stateDir: string;
  credentialRoot?: string;
}): OpCache {
  // A symbol survives separate source/built module evaluations by the plugin loader.
  const host = globalThis as typeof globalThis & { [registryKey]?: CacheRegistry };
  const registry = (host[registryKey] ??= new Map());
  const key = JSON.stringify([
    resolve(scope.packageDir),
    resolve(scope.stateDir),
    scope.credentialRoot === undefined ? null : resolve(scope.credentialRoot),
  ]);
  let cache = registry.get(key);
  if (!cache) {
    // Do not evict an owner while another registration still holds its cache.
    if (registry.size >= maximumInstallations)
      throw new Error('Too many Agent System cache installations in one process.');
    cache = new OpCache();
    registry.set(key, cache);
  }
  return cache;
}
