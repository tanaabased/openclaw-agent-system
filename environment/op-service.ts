import opDiagnostic from './op-diagnostic.ts';
import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type { GetVariablesResponse } from '@1password/sdk';

import OpCache, { opDigest } from './op-cache.ts';

import type { OpEnvironmentRequirements } from './op-requirements.ts';
import type { ManifestDiagnostic } from '../manifest/types.ts';
import type { AgentEnvironmentInputSource } from './resolve.ts';
import type OpCredentialService from '../credentials/op-service.ts';
import type { OpCredentialResolveOptions, OpCredentialSource } from '../credentials/op-service.ts';

export interface OpEnvironmentClient {
  getVariables(environmentId: string): Promise<GetVariablesResponse>;
  resolveSecret(reference: string): Promise<string>;
}

export type CreateOpEnvironmentClient = (
  serviceAccountToken: string,
  integrationVersion: string,
) => Promise<OpEnvironmentClient>;

export type OpEnvironmentLoadResult =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      set: {
        sensitiveNames: string[];
        values: Record<string, string>;
      };
      sources: AgentEnvironmentInputSource[];
    };

export type OpTokenValidationResult =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'valid';
      environmentCount: number;
      secretCount: number;
    };

export type OpCredentialValidationResult =
  | Exclude<OpTokenValidationResult, { status: 'valid' }>
  | {
      status: 'valid';
      environmentCount: number;
      secretCount: number;
      source: OpCredentialSource;
    };

export interface OpEnvironmentServiceDependencies {
  cache?: OpCache;
  createClient?: CreateOpEnvironmentClient;
  credentialService: Pick<OpCredentialService, 'resolveServiceAccountToken'>;
  integrationVersion: string;
  now?: () => number;
  readCachePolicy?: () => unknown;
}

const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const environmentFieldPath = '/environment';
const opFieldPath = '/environment/op';

async function createSdkClient(
  serviceAccountToken: string,
  integrationVersion: string,
): Promise<OpEnvironmentClient> {
  const { createClient } = await import('@1password/sdk');
  const client = await createClient({
    auth: serviceAccountToken,
    integrationName: 'Agent System',
    integrationVersion,
  });
  return {
    getVariables(environmentId) {
      return client.environments.getVariables(environmentId);
    },
    resolveSecret(reference) {
      return client.secrets.resolve(reference);
    },
  };
}

function diagnostic(
  code: string,
  message: string,
  fieldPath = environmentFieldPath,
): ManifestDiagnostic {
  return { code, fieldPath, message, severity: 'error' };
}

function invalid(
  code: string,
  message: string,
  fieldPath = environmentFieldPath,
  evidence?: ProviderDiagnostic,
) {
  return {
    status: 'invalid' as const,
    diagnostics: [
      {
        ...diagnostic(code, message, fieldPath),
        ...(evidence ? { providerDiagnostic: evidence } : {}),
      },
    ],
  };
}

/** Lazily authenticate, validate access, and load declared OP resources. */
export default class OpEnvironmentService {
  readonly #createClient: CreateOpEnvironmentClient;
  readonly #credentialService: Pick<OpCredentialService, 'resolveServiceAccountToken'>;
  readonly #integrationVersion: string;
  readonly #cache: OpCache;
  readonly #readCachePolicy: () => unknown;

  flush(agentId?: string) {
    return this.#cache.flush(agentId);
  }
  status() {
    this.#cache.configure(this.#readCachePolicy());
    return this.#cache.status();
  }

  constructor(dependencies: OpEnvironmentServiceDependencies) {
    this.#createClient = dependencies.createClient ?? createSdkClient;
    this.#credentialService = dependencies.credentialService;
    this.#integrationVersion = dependencies.integrationVersion;
    this.#cache = dependencies.cache ?? new OpCache(dependencies.now);
    this.#readCachePolicy = dependencies.readCachePolicy ?? (() => undefined);
  }

  async load(
    agentId: string,
    requirements: OpEnvironmentRequirements,
    options: { workspaceDir?: string; signal?: AbortSignal; fresh?: boolean } = {},
  ): Promise<OpEnvironmentLoadResult> {
    try {
      this.#cache.configure(this.#readCachePolicy());
    } catch {
      return invalid('op-cache-policy-invalid', 'The operator OP cache policy is invalid.');
    }
    if (requirements.environmentIds.length === 0 && requirements.secrets.length === 0) {
      this.flush(agentId);
      return { status: 'loaded', set: { sensitiveNames: [], values: {} }, sources: [] };
    }

    const requestOrder = this.#cache.nextRequestOrder();
    const generation = this.#cache.generation(agentId);
    const credential = await this.#resolveCredential(agentId);
    if (credential.status !== 'resolved') {
      this.flush(agentId);
      return credential;
    }
    if (options.signal?.aborted) return invalid('op-load-cancelled', 'The OP load was cancelled.');
    const pending = this.#cachedLoad(agentId, credential.token, requirements, {
      generation,
      requestOrder,
      workspaceDir: options.workspaceDir ?? '',
      source: credential.source,
      fresh: options.fresh === true,
    });
    if (!options.signal) return pending;
    const signal = options.signal;
    return new Promise((resolve) => {
      const cancelled = () => resolve(invalid('op-load-cancelled', 'The OP load was cancelled.'));
      signal.addEventListener('abort', cancelled, { once: true });
      void pending
        .then(resolve, () => resolve(invalid('op-load-failed', 'The OP load failed.')))
        .finally(() => signal.removeEventListener('abort', cancelled));
    });
  }

  async validate(
    agentId: string,
    requirements: OpEnvironmentRequirements,
    options: OpCredentialResolveOptions = {},
  ): Promise<OpCredentialValidationResult> {
    if (requirements.environmentIds.length === 0 && requirements.secrets.length === 0) {
      return invalid(
        'op-resource-not-configured',
        'The manifest does not declare an OP resource to validate.',
      );
    }

    try {
      this.#cache.configure(this.#readCachePolicy());
    } catch {
      return invalid('op-cache-policy-invalid', 'The operator OP cache policy is invalid.');
    }
    const requestOrder = this.#cache.nextRequestOrder();
    const generation = this.#cache.generation(agentId);
    const credential = await this.#resolveCredential(agentId, options);
    if (credential.status !== 'resolved') {
      this.flush(agentId);
      return credential;
    }
    const result = await this.#cachedLoad(agentId, credential.token, requirements, {
      generation,
      requestOrder,
      workspaceDir: '',
      source: credential.source,
      fresh: true,
    });
    if (result.status === 'invalid') {
      this.flush(agentId);
      return result;
    }
    return {
      status: 'valid',
      environmentCount: requirements.environmentIds.length,
      secretCount: requirements.secrets.length,
      source: credential.source,
    };
  }

  async validateToken(
    token: string,
    requirements: OpEnvironmentRequirements,
  ): Promise<OpTokenValidationResult> {
    if (requirements.environmentIds.length === 0 && requirements.secrets.length === 0) {
      return invalid(
        'op-resource-not-configured',
        'The manifest does not declare an OP resource to validate.',
      );
    }

    try {
      this.#cache.configure(this.#readCachePolicy());
    } catch {
      return invalid('op-cache-policy-invalid', 'The operator OP cache policy is invalid.');
    }
    const requestOrder = this.#cache.nextRequestOrder();
    const result = await this.#cachedLoad('', token, requirements, {
      requestOrder,
      generation: this.#cache.generation(''),
      workspaceDir: '',
      source: { id: 'candidate', type: 'environment' },
      fresh: true,
    });
    if (result.status === 'invalid') return result;
    return {
      status: 'valid',
      environmentCount: requirements.environmentIds.length,
      secretCount: requirements.secrets.length,
    };
  }

  async #resolveCredential(
    agentId: string,
    options: OpCredentialResolveOptions = {},
  ): Promise<
    | { status: 'resolved'; source: OpCredentialSource; token: string }
    | { status: 'invalid'; diagnostics: ManifestDiagnostic[] }
  > {
    let credential;
    try {
      credential = await this.#credentialService.resolveServiceAccountToken(agentId, options);
    } catch {
      return invalid(
        'op-credential-unavailable',
        'Agent System could not resolve an OP service-account credential.',
        environmentFieldPath,
        providerDiagnostic('1password', 'credential-resolve', 'unknown'),
      );
    }
    if (credential.status === 'resolved') return credential;
    if (credential.status === 'missing') {
      return invalid(
        'op-credential-missing',
        'OP resource resolution requires an available service-account credential.',
        environmentFieldPath,
        providerDiagnostic('1password', 'credential-resolve', 'missing-credential'),
      );
    }
    return invalid(
      credential.code,
      credential.message,
      environmentFieldPath,
      providerDiagnostic('1password', 'credential-resolve', 'unknown'),
    );
  }

  async #cachedLoad(
    agentId: string,
    token: string,
    requirements: OpEnvironmentRequirements,
    options: {
      generation: object;
      requestOrder: number;
      workspaceDir: string;
      source: OpCredentialSource;
      fresh: boolean;
    },
  ): Promise<OpEnvironmentLoadResult> {
    const declaration = structuredClone(requirements);
    // Unknown query transforms bypass retention too; only the stable SSH transform is admitted.
    const retain = declaration.secrets.every(({ reference }) => {
      const query = reference.split('?')[1];
      return (
        !query ||
        [...new URLSearchParams(query)].every(
          ([key, value]) => key === 'ssh-format' && value === 'openssh',
        )
      );
    });
    return this.#cache.load({
      agentId,
      workspaceDir: options.workspaceDir,
      token,
      fingerprint: opDigest([options.source, token, declaration]),
      generation: options.generation,
      requestOrder: options.requestOrder,
      retain,
      fresh: options.fresh,
      createClient: () => this.#createClient(token, this.#integrationVersion),
      fetch: (client) => this.#loadWithClient(client, token, declaration),
    });
  }

  async #loadWithClient(
    client: OpEnvironmentClient,
    token: string,
    requirements: OpEnvironmentRequirements,
  ): Promise<OpEnvironmentLoadResult> {
    const secrets = new Map<string, string>();
    const environments = new Map<string, GetVariablesResponse>();
    const setValues = new Map<string, string>();
    for (const secret of requirements.secrets) {
      try {
        if (!secrets.has(secret.reference)) {
          this.#cache.count('resourceReads');
          secrets.set(secret.reference, await client.resolveSecret(secret.reference));
        }
        setValues.set(secret.name, secrets.get(secret.reference)!);
      } catch (error) {
        const evidence = this.#cache.failure(token, opDiagnostic(error, 'secret-resolve'));
        return invalid(
          'op-secret-unavailable',
          'A declared OP secret could not be resolved.',
          `/environment/set/${secret.name}`,
          evidence,
        );
      }
    }

    const sources: AgentEnvironmentInputSource[] = [];
    for (const [index, environmentId] of requirements.environmentIds.entries()) {
      let response: GetVariablesResponse;
      try {
        if (!environments.has(environmentId)) {
          this.#cache.count('resourceReads');
          environments.set(environmentId, await client.getVariables(environmentId));
        }
        response = environments.get(environmentId)!;
      } catch (error) {
        const evidence = this.#cache.failure(token, opDiagnostic(error, 'environment-read'));
        return invalid(
          'op-environment-unavailable',
          'A declared OP Environment could not be resolved.',
          `${opFieldPath}/${index}`,
          evidence,
        );
      }

      const values = new Map<string, string>();
      const sensitiveNames: string[] = [];
      for (const variable of response.variables) {
        if (!environmentVariableNamePattern.test(variable.name)) {
          this.#cache.count('failures');
          return invalid(
            'op-variable-invalid',
            'A declared OP Environment returned an invalid variable name.',
            `${opFieldPath}/${index}`,
          );
        }
        if (values.has(variable.name)) {
          this.#cache.count('failures');
          return invalid(
            'op-variable-duplicate',
            'A declared OP Environment returned duplicate variable names.',
            `${opFieldPath}/${index}`,
          );
        }
        values.set(variable.name, variable.value);
        if (variable.masked) sensitiveNames.push(variable.name);
      }
      sources.push({
        source: `environment.op[${index}]`,
        sensitiveNames,
        values: Object.fromEntries(values),
      });
    }

    return {
      status: 'loaded',
      set: {
        sensitiveNames: requirements.secrets.map(({ name }) => name),
        values: Object.fromEntries(setValues),
      },
      sources,
    };
  }
}
