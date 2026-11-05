import nativeTaskInstructions from './native-task-instructions.ts';
import implementationContext from './implementation-context.ts';
import codexIssueBranch from './codex-issue-branch.ts';
import pendingPublicResponse from './pending-public-response.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import dispatchContext from './dispatch-context.ts';
import { feedbackWorkContext } from './feedback-work.ts';
import type { ManagedIssue } from './managed-issue.ts';
import workflowRecovery from './workflow-recovery.ts';

/** Prepare the issue branch and skill context under the controller's verified native binding. */
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
  const { client, repo, admitted, selection } = verified;
  const work = record.continuation!;
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
      assessment: record.result,
      reassessments: record.directAssessments,
      implementation: selection,
      previousResult:
        work.result ?? (work.revisionSource ? work.resultHistory?.at(-1)?.result : undefined),
      revision: Boolean(work.revisionSource),
      scope: work.scope,
      existingPullRequest: Boolean(record.adoptedPullRequest),
    }),
    issueStage: record.progression?.stage ?? 'planning',
    issueBranch: record.issueBranch?.name,
    adoptedPullRequest: record.adoptedPullRequest,
    assignmentObservation: record.assignmentObservation,
    assignmentWarning:
      record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
    currentIssue: dispatchContext(
      await client.getItemContext(
        repo.owner.login,
        repo.name,
        admitted.issue.number,
        'issue',
        true,
      ),
      JSON.parse(record.context!).source,
      (deps.now ?? Date.now)(),
    ),
    assessmentSelection: record.assessment,
    routing: record.routing && JSON.parse(record.routing),
    effective: record.effective,
    binding: work.binding,
    feedbackWork: feedbackWorkContext(record),
    pendingPublicResponse: pendingPublicResponse(record),
    instructions: nativeTaskInstructions('codex'),
  };
}
