import projectPickupReport from './project-pickup-report.ts';
import workflowFailure from './workflow-failure.ts';

/** preserve a thrown failure and format it without reading tracking state again. */
export default class ProjectPickupFailure extends Error {
  readonly code: string;
  readonly failure;
  readonly automationId?: string;

  constructor(error: unknown, context: { debug?: boolean; automationId?: string } = {}) {
    const failure = workflowFailure(error, 'project-pickup-observation-unavailable');
    super(error instanceof Error ? error.message : failure.code, { cause: error });
    this.code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
        ? error.code
        : failure.code;
    this.automationId = context.automationId;
    this.failure = {
      status: 'error' as const,
      ...failure,
      ...projectPickupReport({
        outcome: { status: 'failed', ...failure },
        debug: context.debug,
      }),
      instructions:
        'Reproduce response unchanged as the failure report. Preserve the original error and pending work; reconcile any existing assignment attempt instead of repeating its write.',
    };
  }
}
