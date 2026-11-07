import issueWorkflowMode from './issue-workflow-mode.ts';
import type { OperatorIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { Type } from 'typebox';

import { type default as issueProgression, retainedIssueProgression } from './issue-progression.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';

export const feedbackDecisionSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('plan'), Type.Literal('work')]),
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }), {
      minItems: 1,
      maxItems: 10,
    }),
    plan: Type.Optional(Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' })),
  },
  { additionalProperties: false },
);
type Issue = Parameters<typeof issueProgression>[0] & {
  projectWork?: SharedDispatchRecord['projectWork'];
  manualIssue?: Pick<OperatorIssue, 'selections'>;
};

/** Conversation reports the task stage without granting permission to resume stopped work. */
export function feedbackConversationMode(record: Issue, policy: GitHubNotificationPolicy) {
  return retainedIssueProgression(record) ? 'work' : issueWorkflowMode(policy, record);
}

export const feedbackWorkInstructions =
  'Earlier feedback decisions and results are conversation history. Continue appropriate changes in the owning native chat through its shared task permissions and configured implementation skill. This legacy feedback route retains only the original reply and delivery receipts for recovery; do not start another per-comment implementation workflow.';
