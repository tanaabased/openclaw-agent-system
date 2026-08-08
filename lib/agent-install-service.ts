import type { AgentManifest } from '../utils/manifest-types.ts';
import type OpCredentialManager from './op-credential-manager.ts';
import type AgentSystemLifecycleRegistry from './lifecycle-registry.ts';
import type {
  AgentSystemLifecycleOutcome,
  AgentSystemLifecycleWarning,
} from './lifecycle-registry.ts';

export interface AgentInstallResult {
  agentId: string;
  outcomes: AgentSystemLifecycleOutcome[];
  warnings: AgentSystemLifecycleWarning[];
  workspaceDir: string;
}

export interface AgentInstallServiceDependencies {
  credentialManager?: Pick<OpCredentialManager, 'validateStoredForInstall'>;
  lifecycleRegistry: Pick<AgentSystemLifecycleRegistry, 'reconcile'>;
}

export interface AgentInstallInput {
  manifest: AgentManifest;
  workspaceDir: string;
}

export class AgentInstallError extends Error {
  override name = 'AgentInstallError';

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Check global install prerequisites before reconciling every configured lifecycle component. */
export default class AgentInstallService {
  readonly #dependencies: AgentInstallServiceDependencies;

  constructor(dependencies: AgentInstallServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async install(input: AgentInstallInput): Promise<AgentInstallResult> {
    if ((input.manifest.environment?.op?.length ?? 0) > 0) {
      const credentialManager = this.#dependencies.credentialManager;
      if (!credentialManager) {
        throw new AgentInstallError(
          'Stored OP credential validation is unavailable.',
          'op-credential-unavailable',
        );
      }
      const readiness = await credentialManager.validateStoredForInstall(input.manifest);
      if (readiness.status === 'invalid') {
        throw new AgentInstallError(readiness.message, readiness.code);
      }
    }

    const lifecycle = await this.#dependencies.lifecycleRegistry.reconcile(input);
    return {
      agentId: input.manifest.agent.id,
      outcomes: lifecycle.outcomes,
      warnings: lifecycle.warnings,
      workspaceDir: input.workspaceDir,
    };
  }
}
