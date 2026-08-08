import type { CredentialStore } from './credential-store.ts';
import FileCredentialStore, { resolveFileCredentialStoreRoot } from './file-credential-store.ts';
import KeychainCredentialStore from './keychain-credential-store.ts';
import SecretServiceCredentialStore from './secret-service-credential-store.ts';

export interface CredentialStoreRegistryDependencies {
  currentUid?: number;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** Create persistent credential stores in platform preference order. */
export default function createCredentialStores(
  dependencies: CredentialStoreRegistryDependencies,
): CredentialStore[] {
  const fileStore = new FileCredentialStore({
    currentUid: dependencies.currentUid,
    rootDir: resolveFileCredentialStoreRoot(dependencies.environment),
  });
  if (dependencies.platform === 'darwin') {
    return [new KeychainCredentialStore({ platform: dependencies.platform }), fileStore];
  }
  if (dependencies.platform === 'linux') {
    return [
      new SecretServiceCredentialStore({
        environment: dependencies.environment,
        platform: dependencies.platform,
      }),
      fileStore,
    ];
  }
  return [fileStore];
}
