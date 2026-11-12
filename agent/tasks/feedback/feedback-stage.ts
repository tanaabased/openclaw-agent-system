import type { AssessmentSelection } from '../assessment/assessment-selection.ts';
import { selectWorkflowStage } from '../workflow-stage.ts';
import type { AssessmentSkill } from '../assessment/assessment-skill-source.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';

/** the conversation owner selects composition independently of feedback admission. */
export default function selectFeedbackStage(input: {
  policy?: GitHubNotificationPolicy;
  workflow: 'issue-assignment' | 'review-request';
  workspace: string;
  observedAt: number;
  retained?: AssessmentSelection;
  resolveSkill: (id: string) => Promise<AssessmentSkill>;
}) {
  const feedback =
    input.workflow === 'issue-assignment'
      ? input.policy?.issueAssignment?.feedback
      : input.policy?.reviewRequest?.feedback;
  return selectWorkflowStage({
    ...input,
    stage: 'feedback',
    configuration: typeof feedback === 'object' ? feedback : undefined,
    resolveSkill: (id) =>
      input.retained?.requestedSkill === id
        ? Promise.resolve(input.retained.skill)
        : input.resolveSkill(id),
  });
}
