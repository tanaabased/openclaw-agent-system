import type { SharedDispatchRecord } from '../../dispatch-state.ts';
import issueWorkflowMode from '../../issue-workflow-mode.ts';
import type { OperatorIssue } from '../../managed-issue.ts';

import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import {
  type default as issueProgression,
  retainedIssueProgression,
} from '../../issue-progression.ts';
type Issue = Parameters<typeof issueProgression>[0] & {
  projectWork?: SharedDispatchRecord['projectWork'];
  manualIssue?: Pick<OperatorIssue, 'selections'>;
};

/** Conversation reports the task stage without granting permission to resume stopped work. */
export function feedbackConversationMode(record: Issue, policy: GitHubNotificationPolicy) {
  return retainedIssueProgression(record) ? 'work' : issueWorkflowMode(policy, record);
}
