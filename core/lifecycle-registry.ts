import { withProviderDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type SetupLifecycleService from '../agent/setup-lifecycle.ts';
import type { AgentSetupConfiguration } from '../manifest/setup-schema.ts';
import type { AgentManifest, ManifestDiagnostic } from '../manifest/types.ts';

export interface AgentSystemLifecycleContext {
  manifest: AgentManifest;
  setup?: AgentSetupConfiguration;
  workspaceDir: string;
}

export type AgentSystemLifecycleOutcomeStatus = 'created' | 'removed' | 'unchanged' | 'updated';

export interface AgentSystemLifecycleOutcome {
  code: string;
  component: string;
  stepId?: string;
  message: string;
  status: AgentSystemLifecycleOutcomeStatus;
}

export interface AgentSystemLifecycleWarning {
  code: string;
  component: string;
  stepId?: string;
  message: string;
}

export type AgentSystemLifecycleFindingStatus =
  'blocked' | 'drift' | 'healthy' | 'manual' | 'warning';

export interface AgentSystemLifecycleFinding {
  providerDiagnostic?: ProviderDiagnostic;
  code: string;
  component: string;
  stepId?: string;
  message: string;
  remediation?: string;
  status: AgentSystemLifecycleFindingStatus;
}

export interface AgentSystemLifecycleValidationCheck {
  code: string;
  component: string;
  message: string;
  status: 'valid';
}

export interface AgentSystemLifecycleValidationResult {
  checks: AgentSystemLifecycleValidationCheck[];
  diagnostics: ManifestDiagnostic[];
}

export interface AgentSystemLifecycleReconcileResult {
  outcomes: AgentSystemLifecycleOutcome[];
  warnings: AgentSystemLifecycleWarning[];
}

export class AgentSystemLifecycleError extends Error {
  override name = 'AgentSystemLifecycleError';

  constructor(
    readonly component: string,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
    readonly providerDiagnostic?: ProviderDiagnostic,
    readonly stepId?: string,
  ) {
    super(withProviderDiagnostic(message, providerDiagnostic), options);
  }
}

type ContributionDiagnostic = Omit<ManifestDiagnostic, 'component'>;
type ContributionFinding = Omit<AgentSystemLifecycleFinding, 'component'>;
type ContributionOutcome = Omit<AgentSystemLifecycleOutcome, 'component'>;
type ContributionWarning = Omit<AgentSystemLifecycleWarning, 'component'>;

export interface AgentSystemLifecycleContribution {
  id: string;
  isConfigured(manifest: AgentManifest): boolean;
  /** Perform deterministic declaration checks without resolving credentials or inspecting state. */
  validate?(context: AgentSystemLifecycleContext):
    | {
        code: string;
        diagnostics?: readonly ContributionDiagnostic[];
        summary: string;
      }
    | undefined;
  /** Inspect owned state without repairing it. */
  inspect?(context: AgentSystemLifecycleContext): Promise<readonly ContributionFinding[]>;
  /** Reconcile owned state only during an explicit install. */
  reconcile?(context: AgentSystemLifecycleContext): Promise<{
    outcomes: readonly ContributionOutcome[];
    warnings?: readonly ContributionWarning[];
  }>;
}

/** Preserve registration order unless setup requires its fixed prerequisite boundary. */
export default class AgentSystemLifecycleRegistry {
  readonly #contributions: readonly AgentSystemLifecycleContribution[];

  constructor(
    contributions: readonly AgentSystemLifecycleContribution[],
    private readonly setupLifecycle?: Pick<SetupLifecycleService, 'inspect' | 'reconcile'>,
  ) {
    const ids = new Set<string>();
    for (const contribution of contributions) {
      if (contribution.id === 'setup') throw new Error('The setup lifecycle id is reserved.');
      if (ids.has(contribution.id)) {
        throw new Error(`Duplicate Agent System lifecycle contribution id: ${contribution.id}.`);
      }
      ids.add(contribution.id);
    }
    this.#contributions = [...contributions];
  }

  validate(context: AgentSystemLifecycleContext): AgentSystemLifecycleValidationResult {
    const checks: AgentSystemLifecycleValidationCheck[] = [];
    const diagnostics: ManifestDiagnostic[] = [];
    for (const contribution of this.#configured(context.manifest)) {
      let result;
      try {
        result = contribution.validate?.(context);
      } catch {
        diagnostics.push({
          code: `${contribution.id}-validation-failed`,
          component: contribution.id,
          message: `The ${contribution.id} lifecycle declaration could not be validated.`,
          severity: 'error',
        });
        continue;
      }
      if (!result) continue;
      const contributedDiagnostics = (result.diagnostics ?? []).map((diagnostic) => ({
        ...diagnostic,
        component: contribution.id,
      }));
      diagnostics.push(...contributedDiagnostics);
      if (!contributedDiagnostics.some(({ severity }) => severity === 'error')) {
        checks.push({
          code: result.code,
          component: contribution.id,
          message: result.summary,
          status: 'valid',
        });
      }
    }
    return { checks, diagnostics };
  }

  async inspect(context: AgentSystemLifecycleContext): Promise<AgentSystemLifecycleFinding[]> {
    const findings: AgentSystemLifecycleFinding[] = [];
    for (const contribution of this.#ordered(context)) {
      let result;
      try {
        result = await contribution.inspect?.(context);
      } catch {
        findings.push({
          code: `${contribution.id}-inspection-failed`,
          component: contribution.id,
          message: `The ${contribution.id} lifecycle state could not be inspected.`,
          status: 'blocked',
        });
        continue;
      }
      if (!result) continue;
      findings.push(...result.map((finding) => ({ ...finding, component: contribution.id })));
    }
    return findings;
  }

  async reconcile(
    context: AgentSystemLifecycleContext,
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const outcomes: AgentSystemLifecycleOutcome[] = [];
    const warnings: AgentSystemLifecycleWarning[] = [];
    for (const contribution of this.#ordered(context)) {
      let result;
      try {
        result = await contribution.reconcile?.(context);
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        throw new AgentSystemLifecycleError(
          contribution.id,
          `${contribution.id}-reconcile-failed`,
          `The ${contribution.id} lifecycle state could not be reconciled.`,
          { cause: error },
        );
      }
      if (!result) continue;
      outcomes.push(
        ...result.outcomes.map((outcome) => ({ ...outcome, component: contribution.id })),
      );
      warnings.push(
        ...(result.warnings ?? []).map((warning) => ({
          ...warning,
          component: contribution.id,
        })),
      );
    }
    return { outcomes, warnings };
  }

  #ordered(context: AgentSystemLifecycleContext): AgentSystemLifecycleContribution[] {
    const configured = this.#configured(context.manifest);
    if (!context.setup) return configured;
    const setupLifecycle = this.setupLifecycle;
    if (!setupLifecycle) {
      throw new AgentSystemLifecycleError(
        'setup',
        'setup-unavailable',
        'Setup execution is unavailable.',
      );
    }
    // These owners establish the identity, launchers, and credentials needed by setup.
    const prerequisiteIds = ['agent', 'path', 'git', 'github'];
    const prerequisites = prerequisiteIds.flatMap((id) =>
      configured.filter((entry) => entry.id === id),
    );
    const dependent = configured.filter((entry) => !prerequisiteIds.includes(entry.id));
    return [
      ...prerequisites,
      {
        id: 'setup',
        isConfigured: () => true,
        inspect: (input) => setupLifecycle.inspect(input),
        reconcile: async (input) => {
          for (const prerequisite of prerequisites) {
            let findings;
            try {
              findings = await prerequisite.inspect?.(input);
            } catch {
              throw new AgentSystemLifecycleError(
                prerequisite.id,
                'setup-prerequisite-blocked',
                `Setup prerequisite ${prerequisite.id} could not be inspected.`,
              );
            }
            if (findings?.some(({ status }) => status === 'blocked')) {
              throw new AgentSystemLifecycleError(
                prerequisite.id,
                'setup-prerequisite-blocked',
                `Setup prerequisite ${prerequisite.id} is blocked.`,
              );
            }
          }
          return setupLifecycle.reconcile(input);
        },
      },
      ...dependent,
    ];
  }

  #configured(manifest: AgentManifest): AgentSystemLifecycleContribution[] {
    return this.#contributions.filter((contribution) => contribution.isConfigured(manifest));
  }
}
