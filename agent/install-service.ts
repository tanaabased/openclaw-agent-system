import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import sessionDispatchRequirements from './session-dispatch-requirements.ts';
import collectOpEnvironmentRequirements, {
  hasOpEnvironmentRequirements,
} from '../environment/op-requirements.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import type AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import type {
  AgentSystemLifecycleExecutionContext,
  AgentSystemLifecycleOutcome,
  AgentSystemLifecycleWarning,
} from '../core/lifecycle-registry.ts';
import { selectedSetupPhases, type InstallSetupOptions } from './install-options.ts';

export interface AgentInstallResult {
  agentId: string;
  outcomes: AgentSystemLifecycleOutcome[];
  warnings: AgentSystemLifecycleWarning[];
  workspaceDir: string;
}

export interface AgentInstallServiceDependencies {
  sessionDispatch?: Pick<SessionDispatchCredential, 'needsEnrollment'>;
  credentialManager?: Pick<OpCredentialManager, 'validateStoredForInstall'>;
  lifecycleRegistry: Pick<AgentSystemLifecycleRegistry, 'reconcile'>;
}

export interface AgentInstallInput
  extends AgentSystemLifecycleExecutionContext, InstallSetupOptions {}

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

  async sessionDispatchPlan(manifest: AgentInstallInput['manifest']) {
    const consumers = sessionDispatchRequirements(manifest);
    return {
      consumers,
      enrollmentRequired:
        consumers.length > 0 &&
        (this.#dependencies.sessionDispatch
          ? await this.#dependencies.sessionDispatch.needsEnrollment()
          : true),
    };
  }

  async install(input: AgentInstallInput): Promise<AgentInstallResult> {
    input.signal?.throwIfAborted();
    await input.assertCurrent?.();
    if (
      input.runtime === 'openclaw' &&
      sessionDispatchRequirements(input.manifest).length &&
      !input.sessionDispatchConsent
    ) {
      const plan = await this.sessionDispatchPlan(input.manifest);
      if (plan.enrollmentRequired)
        throw new AgentInstallError(
          'Session dispatch enrollment requires explicit Install consent; use interactive Install or --yes.',
          'session-dispatch-approval-required',
        );
    }
    if (hasOpEnvironmentRequirements(collectOpEnvironmentRequirements(input.manifest))) {
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

    const selection = selectedSetupPhases(input);
    const lifecycle = await this.#dependencies.lifecycleRegistry.reconcile(input, selection);
    return {
      agentId: input.manifest.agent.id,
      outcomes: lifecycle.outcomes,
      warnings: [
        ...(selection.skipSetupHost &&
        selection.skipSetupAgent &&
        (input.manifest.setup || input.manifest.setupHost)
          ? [
              {
                code: 'setup-skipped',
                component: 'setup',
                message: 'Setup was skipped; declared steps have not been verified or applied.',
              },
            ]
          : []),
        ...(!selection.skipSetupAgent && selection.skipSetupHost && input.manifest.setupHost
          ? [
              {
                code: 'setup-host-skipped',
                component: 'setup',
                message:
                  'Host setup was skipped; declared steps have not been verified or applied.',
              },
            ]
          : []),
        ...(!selection.skipSetupHost && selection.skipSetupAgent && input.manifest.setup
          ? [
              {
                code: 'setup-agent-skipped',
                component: 'setup',
                message:
                  'Agent setup was skipped; declared steps have not been verified or applied.',
              },
            ]
          : []),
        ...lifecycle.warnings,
      ],
      workspaceDir: input.workspaceDir,
    };
  }
}
