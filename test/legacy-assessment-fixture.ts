import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import { parseAssessmentSubmission } from '../agent/assessment-result.ts';
import { notificationAuthorityDigest } from '../agent/notification-authority.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { AssessmentSelection } from '../agent/assessment-selection.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { validateWorkflowResult } from '../agent/workflow-result.ts';
import { defaultAssessmentSkill } from '../manifest/assessment-schema.ts';
import type { ManagedIssue as IntakeRecord } from '../agent/managed-issue.ts';

/** construct historical records for recovery tests; production no longer writes assessments. */
export default function recordDispatchResult(input: {
  record: SharedDispatchRecord;
  intake: IntakeRecord;
  threadId: string;
  turnId: string;
  worktree: string;
  policy: GitHubNotificationPolicy | undefined;
  result: unknown;
  previousResultDigest?: string;
  assessmentInputs?: { selection: AssessmentSelection; evidence: string };
}) {
  const { record, intake } = input;
  const result = parseAssessmentSubmission(input.result);
  const binding = {
    admissionId: intake.id,
    workflow: 'issue-assignment' as const,
    repositoryId: intake.repository.nodeId,
    subjectId: intake.issue.nodeId,
    threadId: input.threadId,
    turnId: input.turnId,
    worktree: input.worktree,
    dispatchDigest: automationHash(record.request),
    policyDigest: notificationAuthorityDigest(input.policy),
    selectionDigest: automationHash(
      input.assessmentInputs?.selection ?? record.assessment ?? { skill: defaultAssessmentSkill },
    ),
    routingDigest: automationHash({ routing: record.routing, effective: record.effective }),
    evidenceDigest: automationHash(JSON.parse(input.assessmentInputs?.evidence ?? record.context!)),
  };
  validateWorkflowResult(
    {
      version: 1,
      stage: 'assessment',
      resultContract: 'assessment-result/v1',
      binding,
      result,
    },
    { binding, stage: 'assessment', authorized: true },
  );
  if (
    record.result &&
    automationHash(record.result) !== automationHash(result) &&
    input.previousResultDigest !== automationHash(record.result)
  )
    throw new Error('assessment-result-conflict');
  if (!record.result || automationHash(record.result) !== automationHash(result))
    record.assessmentRevision = (record.assessmentRevision ?? 0) + 1;
  record.assessmentRevision ??= 1;
  record.result = result;
  record.stageReceipt = {
    binding,
    resultDigest: automationHash(result),
    ...(input.assessmentInputs ? { selection: input.assessmentInputs.selection } : {}),
  };
  record.resultTurnId = input.turnId;
  record.phase = 'complete';
  return result;
}
