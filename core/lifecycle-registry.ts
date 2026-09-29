import { withProviderDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type SetupLifecycleService from '../agent/setup-lifecycle.ts';
import setupStepApplies from '../agent/setup-runtime.ts';
import type { AgentSetupRuntime } from '../manifest/setup-schema.ts';
import type { AgentManifest, ManifestDiagnostic } from '../manifest/types.ts';
import { selectedSetupPhases, type InstallSetupOptions } from '../agent/install-options.ts';

export interface AgentSystemLifecycleContext {
  manifest: AgentManifest;
  /** Replace the accumulated Codex baseline with the invoking environment during install. */
  rebuildCodexPath?: boolean;
  workspaceDir: string;
}

export interface AgentSystemLifecycleExecutionContext extends AgentSystemLifecycleContext {
  /** Selected by the invoking integration, never by manifest or environment values. */
  runtime: AgentSetupRuntime;
  signal?: AbortSignal;
  /** Recheck one chat-approved plan before each lifecycle boundary. */
  assertCurrent?(): Promise<void>;
}

export type AgentSystemLifecycleOutcomeStatus =
  'created' | 'removed' | 'skipped' | 'unchanged' | 'updated';

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
  'blocked' | 'drift' | 'healthy' | 'manual' | 'skipped' | 'warning';

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

export interface AgentSystemLifecycleWorkItem {
  component: string;
  stepId?: string;
}

export interface AgentSystemLifecycleProgress extends AgentSystemLifecycleReconcileResult {
  unattempted: AgentSystemLifecycleWorkItem[];
}

export class AgentSystemLifecycleError extends Error {
  override name = 'AgentSystemLifecycleError';
  readonly rawMessage: string;

  constructor(
    readonly component: string,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
    readonly providerDiagnostic?: ProviderDiagnostic,
    readonly stepId?: string,
    readonly progress?: AgentSystemLifecycleProgress,
  ) {
    super(withProviderDiagnostic(message, providerDiagnostic), options);
    this.rawMessage = message;
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

type OrderedContribution = AgentSystemLifecycleContribution & { stepIds?: readonly string[] };

function pendingWork(
  contributions: readonly OrderedContribution[],
): AgentSystemLifecycleWorkItem[] {
  return contributions.flatMap(({ id, stepIds }) =>
    stepIds ? stepIds.map((stepId) => ({ component: id, stepId })) : [{ component: id }],
  );
}

/** Preserve registration order around the pre-agent and agent-bound setup boundaries. */
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
    if (context.manifest.setup || context.manifest.setupHost)
      checks.push({
        code: 'setup-declaration-valid',
        component: 'setup',
        status: 'valid',
        message: `Setup declaration with ${(context.manifest.setupHost?.steps.length ?? 0) + (context.manifest.setup?.steps.length ?? 0)} ordered steps`,
      });
    return { checks, diagnostics };
  }

  async inspect(
    context: AgentSystemLifecycleExecutionContext,
  ): Promise<AgentSystemLifecycleFinding[]> {
    const findings: AgentSystemLifecycleFinding[] = [];
    for (const contribution of this.#ordered(context)) {
      context.signal?.throwIfAborted();
      await context.assertCurrent?.();
      let result;
      try {
        result = await contribution.inspect?.(context);
      } catch {
        context.signal?.throwIfAborted();
        await context.assertCurrent?.();
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
    context: AgentSystemLifecycleExecutionContext,
    options: InstallSetupOptions = {},
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const outcomes: AgentSystemLifecycleOutcome[] = [];
    const warnings: AgentSystemLifecycleWarning[] = [];
    const ordered = this.#ordered(context, options);
    for (const [index, contribution] of ordered.entries()) {
      context.signal?.throwIfAborted();
      await context.assertCurrent?.();
      let result;
      try {
        result = await contribution.reconcile?.(context);
      } catch (error) {
        const failure =
          error instanceof AgentSystemLifecycleError
            ? error
            : new AgentSystemLifecycleError(
                contribution.id,
                `${contribution.id}-reconcile-failed`,
                `The ${contribution.id} lifecycle state could not be reconciled.`,
                { cause: error },
              );
        throw new AgentSystemLifecycleError(
          failure.component,
          failure.code,
          failure.rawMessage,
          failure.cause === undefined ? undefined : { cause: failure.cause },
          failure.providerDiagnostic,
          failure.stepId,
          {
            outcomes: [...outcomes, ...(failure.progress?.outcomes ?? [])],
            warnings: [...warnings, ...(failure.progress?.warnings ?? [])],
            unattempted: [
              ...(contribution.id === 'setup' && !failure.progress
                ? pendingWork([contribution])
                : []),
              ...(failure.progress?.unattempted ?? []),
              ...pendingWork(ordered.slice(index + 1)),
            ],
          },
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

  #ordered(
    context: AgentSystemLifecycleExecutionContext,
    options: InstallSetupOptions = {},
  ): OrderedContribution[] {
    const configured = this.#configured(context.manifest);
    const { skipSetupHost, skipSetupAgent } = selectedSetupPhases(options);
    const hostSteps = !skipSetupHost && (context.manifest.setupHost?.steps.length ?? 0) > 0;
    const agentSteps = !skipSetupAgent && (context.manifest.setup?.steps.length ?? 0) > 0;
    if (!hostSteps && !agentSteps) return configured;
    const setupLifecycle = this.setupLifecycle;
    if (!setupLifecycle) {
      throw new AgentSystemLifecycleError(
        'setup',
        'setup-unavailable',
        'Setup execution is unavailable.',
      );
    }
    // These owners establish the identity, launchers, and credentials needed by agent-bound setup.
    const prerequisiteIds =
      agentSteps &&
      context.manifest.setup?.steps.some((step) => setupStepApplies(step, context.runtime))
        ? ['agent', 'path', 'git', 'github', 'google']
        : [];
    const prerequisites = prerequisiteIds.flatMap((id) =>
      configured.filter((entry) => entry.id === id),
    );
    const dependent = configured.filter((entry) => !prerequisiteIds.includes(entry.id));
    return [
      ...(hostSteps
        ? [
            {
              id: 'setup',
              stepIds: context.manifest.setupHost?.steps.map(({ id }) => id),
              isConfigured: () => true,
              inspect: () => setupLifecycle.inspect(context, 'host'),
              reconcile: () => setupLifecycle.reconcile(context, 'host'),
            },
          ]
        : []),
      ...prerequisites,
      ...(agentSteps
        ? [
            {
              id: 'setup',
              stepIds: context.manifest.setup?.steps.map(({ id }) => id),
              isConfigured: () => true,
              inspect: () => setupLifecycle.inspect(context, 'agent'),
              reconcile: async (input: AgentSystemLifecycleExecutionContext) => {
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
                return setupLifecycle.reconcile(context, 'agent');
              },
            },
          ]
        : []),
      ...dependent,
    ];
  }

  #configured(manifest: AgentManifest): AgentSystemLifecycleContribution[] {
    return this.#contributions.filter((contribution) => contribution.isConfigured(manifest));
  }
}
