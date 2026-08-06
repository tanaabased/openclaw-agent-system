import type { AgentManifest } from '../utils/manifest-types.ts';
import type OnePasswordCredentialService from './onepassword-credential-service.ts';
import type OnePasswordEnvironmentService from './onepassword-environment-service.ts';

export interface CredentialManagementFailure {
  code: string;
  message: string;
  status: 'invalid';
}

export type CredentialSetResult =
  | CredentialManagementFailure
  | { agentId: string; status: 'stored' | 'unchanged'; storeId: string };

export type CredentialValidationResult =
  | CredentialManagementFailure
  | {
      agentId: string;
      environmentCount: number;
      source: string;
      status: 'valid';
    };

export type CredentialUnsetResult =
  CredentialManagementFailure | { agentId: string; status: 'removed' | 'missing'; storeId: string };

export type CredentialInstallReadiness = CredentialManagementFailure | { status: 'ready' };

export interface OnePasswordCredentialManagerDependencies {
  credentialService: Pick<
    OnePasswordCredentialService,
    'environmentServiceAccountToken' | 'removeServiceAccountToken' | 'storeServiceAccountToken'
  >;
  environmentService: Pick<OnePasswordEnvironmentService, 'validate' | 'validateToken'>;
}

function failure(result: {
  diagnostics: Array<{ code: string; message: string }>;
}): CredentialManagementFailure {
  const diagnostic = result.diagnostics[0];
  return {
    status: 'invalid',
    code: diagnostic?.code ?? 'op-credential-invalid',
    message: diagnostic?.message ?? 'The OP credential could not be validated.',
  };
}

/** Coordinate OP credential validation and persistent-store mutations for CLI consumers. */
export default class OnePasswordCredentialManager {
  readonly #credentialService: OnePasswordCredentialManagerDependencies['credentialService'];
  readonly #environmentService: OnePasswordCredentialManagerDependencies['environmentService'];

  constructor(dependencies: OnePasswordCredentialManagerDependencies) {
    this.#credentialService = dependencies.credentialService;
    this.#environmentService = dependencies.environmentService;
  }

  async setFromEnvironment(manifest: AgentManifest, storeId: string): Promise<CredentialSetResult> {
    const environmentIds = manifest.environment?.op ?? [];
    const token = this.#credentialService.environmentServiceAccountToken();
    if (!token) {
      return {
        status: 'invalid',
        code: 'op-environment-credential-missing',
        message: 'OP_SERVICE_ACCOUNT_TOKEN is not available to store.',
      };
    }

    const validation = await this.#environmentService.validateToken(token, environmentIds);
    if (validation.status === 'invalid') return failure(validation);

    const stored = await this.#credentialService.storeServiceAccountToken(
      manifest.agent.id,
      storeId,
      token,
    );
    if (stored.status === 'unsafe' || stored.status === 'unavailable') {
      return { status: 'invalid', code: stored.code, message: stored.message };
    }
    return { status: stored.status, agentId: manifest.agent.id, storeId };
  }

  async validate(manifest: AgentManifest, storeId?: string): Promise<CredentialValidationResult> {
    const validated = await this.#environmentService.validate(
      manifest.agent.id,
      manifest.environment?.op ?? [],
      storeId ? { storeId, allowEnvironmentFallback: false } : {},
    );
    if (validated.status === 'invalid') return failure(validated);
    return {
      status: 'valid',
      agentId: manifest.agent.id,
      environmentCount: validated.environmentCount,
      source:
        validated.source.type === 'store' ? `store:${validated.source.id}` : 'process-environment',
    };
  }

  async unset(agentId: string, storeId: string): Promise<CredentialUnsetResult> {
    const removed = await this.#credentialService.removeServiceAccountToken(agentId, storeId);
    if (removed.status === 'unsafe' || removed.status === 'unavailable') {
      return { status: 'invalid', code: removed.code, message: removed.message };
    }
    return { status: removed.status, agentId, storeId };
  }

  async validateStoredForInstall(manifest: AgentManifest): Promise<CredentialInstallReadiness> {
    const environmentIds = manifest.environment?.op ?? [];
    if (environmentIds.length === 0) return { status: 'ready' };

    const validated = await this.#environmentService.validate(manifest.agent.id, environmentIds, {
      allowEnvironmentFallback: false,
    });
    if (validated.status === 'valid') return { status: 'ready' };

    const invalid = failure(validated);
    if (invalid.code !== 'op-credential-missing') return invalid;
    return {
      status: 'invalid',
      code: 'op-credential-not-stored',
      message: `No stored OP credential is available for ${manifest.agent.id}. Run: openclaw agent-system credentials set op --store file --from-env`,
    };
  }
}
