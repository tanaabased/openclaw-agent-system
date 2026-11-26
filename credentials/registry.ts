import type { CredentialStore } from './types.ts';
import FileCredentialStore, { resolveFileCredentialStoreRoot } from './file-store.ts';
import KeychainCredentialStore from './keychain-store.ts';
import SecretServiceCredentialStore from './secret-service-store.ts';

export interface CredentialStoreRegistryDependencies {
  currentUid?: number;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** Select only the platform's OS-managed credential store. */
export function platformCredentialStore(dependencies: CredentialStoreRegistryDependencies) {
  if (dependencies.platform === 'darwin')
    return new KeychainCredentialStore({ platform: dependencies.platform });
  if (dependencies.platform === 'linux') return new SecretServiceCredentialStore(dependencies);
  return undefined;
}

/** Create persistent credential stores in platform preference order. */
export default function createCredentialStores(
  dependencies: CredentialStoreRegistryDependencies,
): CredentialStore[] {
  const fileStore = new FileCredentialStore({
    currentUid: dependencies.currentUid,
    rootDir: resolveFileCredentialStoreRoot(dependencies.environment),
  });
  const platform = platformCredentialStore(dependencies);
  return platform ? [platform, fileStore] : [fileStore];
}
