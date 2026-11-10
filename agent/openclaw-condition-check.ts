import DiscoveryBudget, { DiscoveryPaused } from './discovery-budget.ts';
import workflowFailure from './workflow-failure.ts';

/** reserve ten seconds of the host's thirty-second gate for preparation and final commits. */
export default async function openClawConditionCheck<T>(
  check: (budget: DiscoveryBudget) => Promise<T>,
  signal?: AbortSignal,
  budget = new DiscoveryBudget(20_000, signal),
) {
  const started = budget.clock();
  try {
    return await check(budget);
  } catch (error) {
    const failure = workflowFailure(error, 'dispatch-check-unexpected-error');
    const reason = signal?.aborted
      ? 'caller-aborted'
      : error instanceof DiscoveryPaused
        ? 'discovery-budget-exhausted'
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'operation-timeout'
          : error instanceof Error && error.name === 'TypeError'
            ? 'type-error'
            : error instanceof Error && error.name === 'SyntaxError'
              ? 'syntax-error'
              : failure.code;
    return {
      status: 'ready' as const,
      outcome: 'failed' as const,
      changed: true,
      more: true,
      code:
        reason === 'discovery-budget-exhausted' ? 'dispatch-check-budget-exhausted' : failure.code,
      diagnostic: {
        phase: budget.operation,
        elapsedMs: Math.max(0, budget.clock() - started),
        reason,
        ...(failure.providerDiagnostic ? { providerDiagnostic: failure.providerDiagnostic } : {}),
      },
    };
  }
}
