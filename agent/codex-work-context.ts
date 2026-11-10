import codexWorkState from './codex-work-state.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import implementationContext from './implementation-context.ts';
import assessmentReviewContext from './assessment-review-context.ts';
import codexIssueBranch from './codex-issue-branch.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import workflowRecovery from './workflow-recovery.ts';

/** Prepare the issue branch and skill context under the verified native task binding. */
export default async function codexWorkContext(
  record: DispatchRecord,
  context: Pick<
    CodexWorkContext,
    'records' | 'current' | 'git' | 'signal' | 'save' | 'operatorInput' | 'deps'
  >,
  verified: Awaited<ReturnType<typeof revalidateDispatchAssignment>> & {
    admitted: ManagedIssue;
    selection: AssessmentSelection;
  },
  readOnly = false,
) {
  const { current, git, signal, save, deps } = context;
  const { admitted, selection } = verified;
  const work = codexWorkState(record)!;
  if (!readOnly)
    await codexIssueBranch({
      record,
      records: context.records,
      intake: admitted,
      workspace: current.workspace,
      agentId: current.manifest.agent.id,
      git,
      signal,
      save,
      prepare: true,
    });
  if (!readOnly && context.operatorInput && deps.directScope) work.scope = deps.directScope;
  if (!readOnly) await save();
  return {
    ...implementationContext({
      runtime: 'codex',
      id: record.id,
      path: record.worktree!,
      implementation: selection,
      scope: work.scope,
    }),
    issueStage: record.progression?.stage ?? 'planning',
    issueBranch: record.issueBranch?.name,
    adoptedPullRequest: record.adoptedPullRequest,
    assignmentObservation: record.assignmentObservation,
    assignmentWarning:
      record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
    currentIssue: { source: JSON.parse(record.context!).source },
    initialReview: assessmentReviewContext(record, JSON.parse(record.context!).source),
    routing: record.routing && JSON.parse(record.routing),
    effective: record.effective,
    continuationRequest: { action: 'context' as const, id: record.id },
    deliveryPrepareRequest: { action: 'prepare' as const, id: record.id },
    instructions: nativeTaskInstructions('codex'),
  };
}
