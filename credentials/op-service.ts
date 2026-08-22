import type { CredentialStore, CredentialStoreProblem } from './types.ts';

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

export type OpCredentialStoreWriteResult =
  CredentialStoreProblem | { status: 'stored' | 'unchanged'; storeId: string };

export type OpCredentialStoreRemoveResult =
  | CredentialStoreProblem
  | {
      status: 'removed' | 'missing';
      storeIds: string[];
      unavailableStoreIds: string[];
    };

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

    let missing = false;
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
      if (result.status === 'missing') missing = true;
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

    return missing ? { status: 'missing' } : (unavailable ?? { status: 'missing' });
  }

  async storeServiceAccountToken(
    agentId: string,
    storeId: string | undefined,
    token: string,
  ): Promise<OpCredentialStoreWriteResult> {
    const stores = storeId ? this.#stores.filter(({ id }) => id === storeId) : this.#stores;
    if (storeId && stores.length === 0) {
      return {
        status: 'unavailable',
        code: 'credential-store-unknown',
        message: `Credential store ${storeId} is not available.`,
      };
    }
    if (stores.length === 0) {
      return {
        status: 'unavailable',
        code: 'credential-store-unavailable',
        message: 'No credential store is available.',
      };
    }

    let unavailable: CredentialStoreProblem | undefined;
    for (const store of stores) {
      const result = await store.write({ agentId, credentialId: opCredentialId }, token);
      if (result.status === 'stored' || result.status === 'unchanged') {
        return { ...result, storeId: store.id };
      }
      if ('code' in result) {
        if (result.status === 'unsafe') return result;
        unavailable ??= result;
      }
    }
    return (
      unavailable ?? {
        status: 'unavailable',
        code: 'credential-store-unavailable',
        message: 'No credential store is available.',
      }
    );
  }

  async removeServiceAccountToken(
    agentId: string,
    storeId?: string,
  ): Promise<OpCredentialStoreRemoveResult> {
    const stores = storeId ? this.#stores.filter(({ id }) => id === storeId) : this.#stores;
    if (storeId && stores.length === 0) {
      return {
        status: 'unavailable',
        code: 'credential-store-unknown',
        message: `Credential store ${storeId} is not available.`,
      };
    }
    if (stores.length === 0) {
      return {
        status: 'unavailable',
        code: 'credential-store-unavailable',
        message: 'No credential store is available.',
      };
    }

    const checkedStoreIds: string[] = [];
    const removedStoreIds: string[] = [];
    const unavailableStoreIds: string[] = [];
    let unavailable: CredentialStoreProblem | undefined;
    for (const store of stores) {
      const result = await store.remove({ agentId, credentialId: opCredentialId });
      if (result.status === 'unsafe') return result;
      if (result.status === 'unavailable') {
        unavailable ??= result;
        unavailableStoreIds.push(store.id);
        continue;
      }
      checkedStoreIds.push(store.id);
      if (result.status === 'removed') removedStoreIds.push(store.id);
    }

    if (checkedStoreIds.length === 0) {
      return (
        unavailable ?? {
          status: 'unavailable',
          code: 'credential-store-unavailable',
          message: 'No credential store is available.',
        }
      );
    }
    return {
      status: removedStoreIds.length > 0 ? 'removed' : 'missing',
      storeIds: removedStoreIds.length > 0 ? removedStoreIds : checkedStoreIds,
      unavailableStoreIds,
    };
  }
}
