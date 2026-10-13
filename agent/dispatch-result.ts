import { parseAssessmentResult } from './assessment-result.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { validateWorkflowResult } from './workflow-result.ts';
import { defaultAssessmentSkill } from '../manifest/assessment-schema.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

/** Both runtimes bind the same result contract after verifying their native caller. */
export default function recordDispatchResult(input: {
  record: SharedDispatchRecord;
  intake: IntakeRecord;
  threadId: string;
  turnId: string;
  worktree: string;
  policy: unknown;
  result: unknown;
  previousResultDigest?: string;
}) {
  const { record, intake } = input;
  const result = parseAssessmentResult(input.result);
  const binding = {
    admissionId: intake.id,
    workflow: 'issue-assignment' as const,
    repositoryId: intake.repository.nodeId,
    subjectId: intake.issue.nodeId,
    threadId: input.threadId,
    turnId: input.turnId,
    worktree: input.worktree,
    dispatchDigest: automationHash(record.request),
    policyDigest: automationHash(input.policy ?? null),
    selectionDigest: automationHash(record.assessment ?? { skill: defaultAssessmentSkill }),
    routingDigest: automationHash({ routing: record.routing, effective: record.effective }),
    evidenceDigest: automationHash(JSON.parse(record.context!)),
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
  record.result = result;
  record.stageReceipt = { binding, resultDigest: automationHash(result) };
  record.resultTurnId = input.turnId;
  record.phase = 'complete';
  return result;
}
