import type {
  CredentialStore,
  CredentialStoreProblem,
  CredentialStoreRemoveResult,
  CredentialStoreWriteResult,
} from './credential-store.ts';

export const onePasswordCredentialId = 'op';
export const onePasswordServiceAccountTokenEnvironmentVariable = 'OP_SERVICE_ACCOUNT_TOKEN';

export interface OnePasswordCredentialSource {
  id: string;
  type: 'environment' | 'store';
}

export type OnePasswordCredentialResolution =
  | CredentialStoreProblem
  | {
      source: OnePasswordCredentialSource;
      status: 'resolved';
      token: string;
    }
  | { status: 'missing' };

export interface OnePasswordCredentialResolveOptions {
  allowEnvironmentFallback?: boolean;
  storeId?: string;
}

export interface OnePasswordCredentialServiceDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  stores?: readonly CredentialStore[];
}

/** Resolve and mutate agent-scoped OP credentials without exposing their values as metadata. */
export default class OnePasswordCredentialService {
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #stores: readonly CredentialStore[];

  constructor(dependencies: OnePasswordCredentialServiceDependencies) {
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
    this.#stores = [...(dependencies.stores ?? [])];
  }

  environmentServiceAccountToken(): string | undefined {
    const token = this.#hostEnvironment[onePasswordServiceAccountTokenEnvironmentVariable];
    return token !== undefined && token.trim() !== '' ? token : undefined;
  }

  async resolveServiceAccountToken(
    agentId: string,
    options: OnePasswordCredentialResolveOptions = {},
  ): Promise<OnePasswordCredentialResolution> {
    const stores = options.storeId
      ? this.#stores.filter(({ id }) => id === options.storeId)
      : this.#stores;
    if (options.storeId && stores.length === 0) {
      return {
        status: 'unavailable',
        code: 'credential-store-unknown',
        message: `Credential store ${options.storeId} is not available.`,
      };
    }

    let unavailable: CredentialStoreProblem | undefined;
    for (const store of stores) {
      const result = await store.read({ agentId, credentialId: onePasswordCredentialId });
      if (result.status === 'found') {
        return {
          status: 'resolved',
          source: { id: store.id, type: 'store' },
          token: result.value,
        };
      }
      if (result.status === 'unsafe') return result;
      if (result.status === 'unavailable') unavailable ??= result;
    }

    if (!options.storeId && options.allowEnvironmentFallback !== false) {
      const token = this.environmentServiceAccountToken();
      if (token) {
        return {
          status: 'resolved',
          source: { id: 'process-environment', type: 'environment' },
          token,
        };
      }
    }

    return unavailable ?? { status: 'missing' };
  }

  async storeServiceAccountToken(
    agentId: string,
    storeId: string,
    token: string,
  ): Promise<CredentialStoreWriteResult> {
    const store = this.#stores.find(({ id }) => id === storeId);
    if (!store) {
      return {
        status: 'unavailable',
        code: 'credential-store-unknown',
        message: `Credential store ${storeId} is not available.`,
      };
    }
    return store.write({ agentId, credentialId: onePasswordCredentialId }, token);
  }

  async removeServiceAccountToken(
    agentId: string,
    storeId: string,
  ): Promise<CredentialStoreRemoveResult> {
    const store = this.#stores.find(({ id }) => id === storeId);
    if (!store) {
      return {
        status: 'unavailable',
        code: 'credential-store-unknown',
        message: `Credential store ${storeId} is not available.`,
      };
    }
    return store.remove({ agentId, credentialId: onePasswordCredentialId });
  }
}
