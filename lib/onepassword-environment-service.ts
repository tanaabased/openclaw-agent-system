import type { GetVariablesResponse } from '@1password/sdk';

import type { ManifestDiagnostic } from '../utils/manifest-types.ts';
import type { AgentEnvironmentInputSource } from '../utils/resolve-agent-environment.ts';
import type OnePasswordCredentialService from './onepassword-credential-service.ts';

export interface OnePasswordEnvironmentClient {
  getVariables(environmentId: string): Promise<GetVariablesResponse>;
}

export type CreateOnePasswordEnvironmentClient = (
  serviceAccountToken: string,
  integrationVersion: string,
) => Promise<OnePasswordEnvironmentClient>;

export type OnePasswordEnvironmentLoadResult =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      sources: AgentEnvironmentInputSource[];
    };

export interface OnePasswordEnvironmentServiceDependencies {
  createClient?: CreateOnePasswordEnvironmentClient;
  credentialService: Pick<OnePasswordCredentialService, 'resolveServiceAccountToken'>;
  integrationVersion: string;
}

const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function createSdkClient(
  serviceAccountToken: string,
  integrationVersion: string,
): Promise<OnePasswordEnvironmentClient> {
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

function diagnostic(code: string, message: string, fieldPath: string): ManifestDiagnostic {
  return { code, fieldPath, message, severity: 'error' };
}

/** Lazily authenticate and load ordered 1Password Environment variables. */
export default class OnePasswordEnvironmentService {
  readonly #createClient: CreateOnePasswordEnvironmentClient;
  readonly #credentialService: Pick<OnePasswordCredentialService, 'resolveServiceAccountToken'>;
  readonly #integrationVersion: string;

  constructor(dependencies: OnePasswordEnvironmentServiceDependencies) {
    this.#createClient = dependencies.createClient ?? createSdkClient;
    this.#credentialService = dependencies.credentialService;
    this.#integrationVersion = dependencies.integrationVersion;
  }

  async load(
    agentId: string,
    environmentIds: readonly string[],
  ): Promise<OnePasswordEnvironmentLoadResult> {
    if (environmentIds.length === 0) return { status: 'loaded', sources: [] };

    let serviceAccountToken: string | undefined;
    try {
      serviceAccountToken = await this.#credentialService.resolveServiceAccountToken(agentId);
    } catch {
      return {
        status: 'invalid',
        diagnostics: [
          diagnostic(
            'onepassword-credential-unavailable',
            'Agent System could not resolve a 1Password service-account credential.',
            '/environment/onepassword-environments',
          ),
        ],
      };
    }
    if (!serviceAccountToken) {
      return {
        status: 'invalid',
        diagnostics: [
          diagnostic(
            'onepassword-credential-missing',
            '1Password Environment resolution requires an available service-account credential.',
            '/environment/onepassword-environments',
          ),
        ],
      };
    }

    let client: OnePasswordEnvironmentClient;
    try {
      client = await this.#createClient(serviceAccountToken, this.#integrationVersion);
    } catch {
      return {
        status: 'invalid',
        diagnostics: [
          diagnostic(
            'onepassword-authentication-failed',
            'Agent System could not authenticate the 1Password SDK client.',
            '/environment/onepassword-environments',
          ),
        ],
      };
    }

    const sources: AgentEnvironmentInputSource[] = [];
    for (const [index, environmentId] of environmentIds.entries()) {
      const fieldPath = `/environment/onepassword-environments/${index}`;
      let response: GetVariablesResponse;
      try {
        response = await client.getVariables(environmentId);
      } catch {
        return {
          status: 'invalid',
          diagnostics: [
            diagnostic(
              'onepassword-environment-unavailable',
              'A declared 1Password Environment could not be resolved.',
              fieldPath,
            ),
          ],
        };
      }

      const values = new Map<string, string>();
      const sensitiveNames: string[] = [];
      for (const variable of response.variables) {
        if (!environmentVariableNamePattern.test(variable.name)) {
          return {
            status: 'invalid',
            diagnostics: [
              diagnostic(
                'onepassword-variable-invalid',
                'A declared 1Password Environment returned an invalid variable name.',
                fieldPath,
              ),
            ],
          };
        }
        if (values.has(variable.name)) {
          return {
            status: 'invalid',
            diagnostics: [
              diagnostic(
                'onepassword-variable-duplicate',
                'A declared 1Password Environment returned duplicate variable names.',
                fieldPath,
              ),
            ],
          };
        }
        values.set(variable.name, variable.value);
        if (variable.masked) sensitiveNames.push(variable.name);
      }
      sources.push({
        source: `environment.onepassword-environments[${index}]`,
        sensitiveNames,
        values: Object.fromEntries(values),
      });
    }

    return { status: 'loaded', sources };
  }
}
