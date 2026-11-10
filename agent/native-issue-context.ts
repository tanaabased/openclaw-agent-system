import type { IssueWorkflowState } from './workflow-status.ts';

export function nativeIssueContext(
  record: IssueWorkflowState & {
    id: string;
    worktree?: string;
    issueBranch?: { name: string };
    pullRequestLink?: { pullRequestNodeId: string; pullRequestNumber: number } | null;
  },
) {
  return {
    status: 'native' as const,
    id: record.id,
    project: { path: record.worktree },
    branch: record.issueBranch?.name ?? record.delivery?.binding?.branch,
    pullRequest:
      record.pullRequestLink !== undefined
        ? (record.pullRequestLink ?? undefined)
        : record.delivery?.pullRequest,
    instructions:
      'Continue the ordinary native conversation under current authorized direction in this checkout and any linked PR. This is retained context, not a new execution grant or implementation round. Do not enter assessment context/result, continuation, handoff, or implementation-result tracking. Replan in chat without saving another managed assessment. Use the configured assessment or implementation skill directly when useful. Use the existing delivery operation only for requested PR publication, attachment or card presentation, and explicitly invoke Task Update within authorized publication scope after a material plan revision, a clarification decision that changes the approach, or a later delivery to this PR. Coalesce changes and skip per-push or already-public updates. Show its exact rendered reply and publication outcome in this chat; publication failure does not block work. General updates target the linked open PR or otherwise the issue; their external-effect receipts remain authoritative. No scheduler activation or old automatic-send receipt governs this conversation.',
  };
}
