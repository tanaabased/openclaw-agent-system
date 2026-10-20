import { selectWorkflowStage } from './workflow-stage.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';

/** the conversation owner selects composition independently of feedback admission. */
export default function selectFeedbackStage(input: {
  policy: GitHubNotificationPolicy;
  workflow: 'issue-assignment' | 'review-request';
  workspace: string;
  observedAt: number;
  resolveSkill: (id: string) => Promise<CodexAssessmentSkill>;
}) {
  const feedback =
    input.workflow === 'issue-assignment'
      ? input.policy.issueAssignment?.feedback
      : input.policy.reviewRequest?.feedback;
  return selectWorkflowStage({
    ...input,
    stage: 'feedback',
    configuration: typeof feedback === 'object' ? feedback : undefined,
  });
}
