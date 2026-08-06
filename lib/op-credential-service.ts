import type {
  CredentialStore,
  CredentialStoreProblem,
  CredentialStoreRemoveResult,
  CredentialStoreWriteResult,
} from './credential-store.ts';

export const opCredentialId = 'op';
export const opServiceAccountTokenEnvironmentVariable = 'OP_SERVICE_ACCOUNT_TOKEN';

export interface OpCredentialSource {
  id: string;
  type: 'environment' | 'store';
}

export type OpCredentialResolution =
  | CredentialStoreProblem
  | {
      source: OpCredentialSource;
      status: 'resolved';
      token: string;
    }
  | { status: 'missing' };

export interface OpCredentialResolveOptions {
  allowEnvironmentFallback?: boolean;
  storeId?: string;
}

export interface OpCredentialServiceDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  stores?: readonly CredentialStore[];
}

/** Resolve and mutate agent-scoped OP credentials without exposing their values as metadata. */
export default class OpCredentialService {
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #stores: readonly CredentialStore[];

  constructor(dependencies: OpCredentialServiceDependencies) {
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
    this.#stores = [...(dependencies.stores ?? [])];
  }

  environmentServiceAccountToken(): string | undefined {
    const token = this.#hostEnvironment[opServiceAccountTokenEnvironmentVariable];
    return token !== undefined && token.trim() !== '' ? token : undefined;
  }

  async resolveServiceAccountToken(
    agentId: string,
    options: OpCredentialResolveOptions = {},
  ): Promise<OpCredentialResolution> {
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
      const result = await store.read({ agentId, credentialId: opCredentialId });
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
    return store.write({ agentId, credentialId: opCredentialId }, token);
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
    return store.remove({ agentId, credentialId: opCredentialId });
  }
}
