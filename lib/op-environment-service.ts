import type { GetVariablesResponse } from '@1password/sdk';

import type { ManifestDiagnostic } from '../utils/manifest-types.ts';
import type { AgentEnvironmentInputSource } from '../utils/resolve-agent-environment.ts';
import type OpCredentialService from './op-credential-service.ts';
import type { OpCredentialResolveOptions, OpCredentialSource } from './op-credential-service.ts';

export interface OpEnvironmentClient {
  getVariables(environmentId: string): Promise<GetVariablesResponse>;
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
    };

export type OpCredentialValidationResult =
  | Exclude<OpTokenValidationResult, { status: 'valid' }>
  | {
      status: 'valid';
      environmentCount: number;
      source: OpCredentialSource;
    };

export interface OpEnvironmentServiceDependencies {
  createClient?: CreateOpEnvironmentClient;
  credentialService: Pick<OpCredentialService, 'resolveServiceAccountToken'>;
  integrationVersion: string;
}

const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  };
}

function diagnostic(code: string, message: string, fieldPath = opFieldPath): ManifestDiagnostic {
  return { code, fieldPath, message, severity: 'error' };
}

function invalid(code: string, message: string, fieldPath = opFieldPath) {
  return { status: 'invalid' as const, diagnostics: [diagnostic(code, message, fieldPath)] };
}

/** Lazily authenticate, validate access, and load ordered OP Environment variables. */
export default class OpEnvironmentService {
  readonly #createClient: CreateOpEnvironmentClient;
  readonly #credentialService: Pick<OpCredentialService, 'resolveServiceAccountToken'>;
  readonly #integrationVersion: string;

  constructor(dependencies: OpEnvironmentServiceDependencies) {
    this.#createClient = dependencies.createClient ?? createSdkClient;
    this.#credentialService = dependencies.credentialService;
    this.#integrationVersion = dependencies.integrationVersion;
  }

  async load(agentId: string, environmentIds: readonly string[]): Promise<OpEnvironmentLoadResult> {
    if (environmentIds.length === 0) return { status: 'loaded', sources: [] };

    const credential = await this.#resolveCredential(agentId);
    if (credential.status !== 'resolved') return credential;
    return this.#loadWithToken(credential.token, environmentIds);
  }

  async validate(
    agentId: string,
    environmentIds: readonly string[],
    options: OpCredentialResolveOptions = {},
  ): Promise<OpCredentialValidationResult> {
    if (environmentIds.length === 0) {
      return invalid(
        'op-environment-not-configured',
        'The manifest does not declare an OP Environment to validate.',
      );
    }

    const credential = await this.#resolveCredential(agentId, options);
    if (credential.status !== 'resolved') return credential;
    const result = await this.validateToken(credential.token, environmentIds);
    return result.status === 'valid' ? { ...result, source: credential.source } : result;
  }

  async validateToken(
    token: string,
    environmentIds: readonly string[],
  ): Promise<OpTokenValidationResult> {
    if (environmentIds.length === 0) {
      return invalid(
        'op-environment-not-configured',
        'The manifest does not declare an OP Environment to validate.',
      );
    }

    const client = await this.#authenticatedClient(token);
    if (client.status === 'invalid') return client;
    for (const [index, environmentId] of environmentIds.entries()) {
      try {
        await client.client.getVariables(environmentId);
      } catch {
        return invalid(
          'op-environment-unavailable',
          'A declared OP Environment could not be accessed with the selected credential.',
          `${opFieldPath}/${index}`,
        );
      }
    }
    return { status: 'valid', environmentCount: environmentIds.length };
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
      );
    }
    if (credential.status === 'resolved') return credential;
    if (credential.status === 'missing') {
      return invalid(
        'op-credential-missing',
        'OP Environment resolution requires an available service-account credential.',
      );
    }
    return invalid(credential.code, credential.message);
  }

  async #authenticatedClient(
    token: string,
  ): Promise<
    | { status: 'authenticated'; client: OpEnvironmentClient }
    | { status: 'invalid'; diagnostics: ManifestDiagnostic[] }
  > {
    try {
      return {
        status: 'authenticated',
        client: await this.#createClient(token, this.#integrationVersion),
      };
    } catch {
      return invalid(
        'op-authentication-failed',
        'Agent System could not authenticate the OP SDK client.',
      );
    }
  }

  async #loadWithToken(
    token: string,
    environmentIds: readonly string[],
  ): Promise<OpEnvironmentLoadResult> {
    const client = await this.#authenticatedClient(token);
    if (client.status === 'invalid') return client;

    const sources: AgentEnvironmentInputSource[] = [];
    for (const [index, environmentId] of environmentIds.entries()) {
      let response: GetVariablesResponse;
      try {
        response = await client.client.getVariables(environmentId);
      } catch {
        return invalid(
          'op-environment-unavailable',
          'A declared OP Environment could not be resolved.',
          `${opFieldPath}/${index}`,
        );
      }

      const values = new Map<string, string>();
      const sensitiveNames: string[] = [];
      for (const variable of response.variables) {
        if (!environmentVariableNamePattern.test(variable.name)) {
          return invalid(
            'op-variable-invalid',
            'A declared OP Environment returned an invalid variable name.',
            `${opFieldPath}/${index}`,
          );
        }
        if (values.has(variable.name)) {
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

    return { status: 'loaded', sources };
  }
}
