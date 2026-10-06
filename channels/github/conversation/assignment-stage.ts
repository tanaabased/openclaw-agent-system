type AssignmentStage =
  | 'initialization'
  | 'context'
  | 'acknowledgment'
  | 'execution'
  | 'checkpoint'
  | 'publication'
  | 'implementation'
  | 'delivery'
  | 'handoff';

export class GitHubAssignmentStageError extends Error {
  override name = 'GitHubAssignmentStageError';
  readonly code: string;

  constructor(
    readonly stage: AssignmentStage,
    cause: unknown,
  ) {
    super(`The GitHub assignment failed during ${stage}.`, { cause });
    this.code = `github-notification-assignment-${stage}-failed`;
  }
}

/** preserve the innermost lifecycle stage and cause without exposing arbitrary errors. */
export default async function assignmentStage<T>(
  stage: AssignmentStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitHubAssignmentStageError) throw error;
    throw new GitHubAssignmentStageError(stage, error);
  }
}
