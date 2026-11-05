import type { IssueWorkflowState } from './workflow-status.ts';

/** Compatibility presentation fact derived from the external operation, never from a saved result. */
export function hasDeliveredImplementation(record: IssueWorkflowState): boolean {
  if (record.implementationDelivered) return true;
  const delivered = (delivery: IssueWorkflowState['delivery']) =>
    Boolean(
      delivery?.pullRequest && delivery.reconciled && (!delivery.adopted || delivery.pushedHead),
    );
  return (
    delivered(record.delivery ?? record.work?.delivery) ||
    Boolean(record.feedback?.events.some((event) => delivered(event.workDelivery)))
  );
}

/** Preserve the first publication fact while later operations retain their own receipts. */
export function retainImplementationDelivery(record: IssueWorkflowState): void {
  if (hasDeliveredImplementation(record)) record.implementationDelivered = true;
}

export function nativeIssueContext(
  record: IssueWorkflowState & {
    id: string;
    worktree?: string;
    issueBranch?: { name: string };
    directAssessments?: unknown;
    pullRequestLink?: { pullRequestNodeId: string; pullRequestNumber: number } | null;
  },
) {
  return {
    status: 'native' as const,
    id: record.id,
    project: { path: record.worktree },
    branch: record.issueBranch?.name ?? (record.delivery ?? record.work?.delivery)?.binding?.branch,
    pullRequest:
      record.pullRequestLink !== undefined
        ? (record.pullRequestLink ?? undefined)
        : (record.delivery ?? record.work?.delivery)?.pullRequest,
    assessment: record.result,
    reassessments: record.directAssessments,
    implementationResult: record.continuation?.result ?? record.work?.result,
    instructions:
      'The initial implementation and linked PR are delivered. Continue the ordinary native conversation under current authorized direction in this checkout and PR. This is retained context, not a new execution grant or implementation round. Do not enter assessment context/result, continuation, handoff, or implementation-result tracking. Replan in chat without saving another managed assessment. Use the configured assessment or implementation skill directly when useful. Preserve historical results. Use the existing delivery operation only for requested PR publication, attachment or card presentation, and explicitly invoke Task Update within authorized publication scope after a material plan revision, a clarification decision that changes the approach, or a later delivery to this PR. Coalesce changes and skip per-push or already-public updates. Show its exact rendered reply and publication outcome in this chat; publication failure does not block work. General updates target the linked open PR or otherwise the issue; their external-effect receipts remain authoritative. No scheduler activation or old automatic-send receipt governs this conversation.',
  };
}
