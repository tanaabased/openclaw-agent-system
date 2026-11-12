import { automationHash } from '../../automation-hash.ts';
import type { ManagedIssue } from '../managed-issue.ts';
import type IntakeStore from '../../../channels/github/intake/record-store.ts';

/** consumed assignment identity outlives local task data; manual unassigned work needs none. */
export default async function retirementConsumption(
  store: IntakeStore,
  intake: ManagedIssue,
  taskId: string,
  now: number,
  consumedThrough: number,
) {
  const assignment =
    intake.assignment ?? ('initiation' in intake ? intake.assignmentAttempt?.event : undefined);
  if (!assignment) return;
  await store.consume(
    {
      version: 1,
      id: automationHash([
        intake.scope,
        intake.repository.nodeId,
        intake.issue.nodeId,
        assignment.nodeId,
      ]),
      scope: intake.scope,
      receiving: intake.receiving,
      workspaceDir: intake.workspaceDir,
      agentId: intake.agentId,
      host: intake.host,
      repository: intake.repository,
      issue: intake.issue,
      assignment,
      observedAt: now,
    },
    taskId,
    consumedThrough,
  );
}
