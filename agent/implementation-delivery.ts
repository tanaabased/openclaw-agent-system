import type { IssueWorkflowState } from './issue-workflow-progress.ts';

/** Initial PR delivery ends execution ownership; later publication receipts may change. */
export function hasDeliveredImplementation(record: IssueWorkflowState): boolean {
  if (record.implementationDelivered) return true;
  const work = record.continuation?.phase ? record.continuation : record.work;
  const delivery = record.delivery ?? record.work?.delivery;
  return Boolean(
    (work?.scope !== 'local' &&
      delivery?.pullRequest &&
      delivery.reconciled &&
      (work?.result?.outcome === 'done' ||
        (work?.resultHistory?.some(({ result }) => result.outcome === 'done') &&
          (!record.continuation?.phase || record.continuation.head))) &&
      (!record.continuation?.head || delivery.pushedHead === record.continuation.head)) ||
    record.feedback?.events.some((event) => {
      const linked = event.workDelivery ?? delivery;
      return (
        event.work?.result?.outcome === 'done' &&
        event.work.head &&
        linked?.pullRequest &&
        linked.reconciled &&
        linked.pushedHead === event.work.head
      );
    }),
  );
}

/** Retain the terminal fact before a later push changes its effect receipts. */
export function retainImplementationDelivery(record: IssueWorkflowState): void {
  if (hasDeliveredImplementation(record)) record.implementationDelivered = true;
}

export function nativeIssueContext(
  record: IssueWorkflowState & {
    id: string;
    worktree?: string;
    issueBranch?: { name: string };
    directAssessments?: unknown;
  },
) {
  return {
    status: 'native' as const,
    id: record.id,
    project: { path: record.worktree },
    branch: record.issueBranch?.name ?? (record.delivery ?? record.work?.delivery)?.binding?.branch,
    pullRequest: (record.delivery ?? record.work?.delivery)?.pullRequest,
    assessment: record.result,
    reassessments: record.directAssessments,
    implementationResult: record.continuation?.result ?? record.work?.result,
    instructions:
      'The initial implementation and linked PR are delivered. Continue the ordinary native conversation under current authorized direction in this checkout and PR. This is retained context, not a new execution grant or implementation round. Do not enter assessment context/result, continuation, handoff, or implementation-result tracking. Replan in chat without saving another managed assessment. Use the configured assessment or implementation skill directly when useful. Preserve historical results. Use the existing delivery operation only for requested PR publication, attachment or card presentation, and Task Update for material progress on the linked open PR or otherwise the issue; their external-effect receipts remain authoritative. No scheduler activation or old automatic-send receipt governs this conversation.',
  };
}
