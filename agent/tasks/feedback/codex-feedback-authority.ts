import assignmentIntakePolicy from '../../automations/assignment-intake-policy.ts';
import { inspectFeedbackAssignment } from './assignment-feedback-reactivation.ts';
import { inspectIssueIdentity } from '../dispatch/dispatch-assignment.ts';
import authorizeFeedback from './feedback-source-context.ts';
import { WorkflowPolicyHeld } from '../live-workflow-policy.ts';
import type { DispatchRecord } from '../dispatch/codex-dispatch-state.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationCommentClient,
} from '../../../channels/github/provider/work-event-types.ts';
import type { CodexTaskSelection } from '../context/codex-task-context.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ManagedIssue as IntakeRecord } from '../managed-issue.ts';

/** verify the exact admitted source before work and every dependent provider write. */
export default async function authorizeCodexFeedback(input: {
  conversation?: boolean;
  current: CodexTaskSelection;
  record: DispatchRecord;
  event: Pick<FeedbackSourceEvent, 'number' | 'nodeId' | 'itemType' | 'source' | 'revision'>;
  intake: IntakeRecord;
  provider: {
    client: GitHubNotificationIntakeClient;
    comments: GitHubNotificationCommentClient;
  };
}) {
  const { current, record, event, intake, provider } = input;
  if (record.supersededBy) throw new Error('dispatch-task-superseded');
  const policy = current.manifest.github?.notifications;
  if (!policy) throw new WorkflowPolicyHeld('feedback-disabled');
  await authorizeFeedback({
    conversation: input.conversation,
    record,
    event,
    intake,
    policy,
    provider: {
      identity: provider.comments.identity,
      reviews: provider.comments.reviews,
      getItem: (...args) => provider.client.getItem(...args),
      getIssueComment: (...args) => provider.comments.getIssueComment(...args),
    },
    assertCurrent: async () => {},
    reauthorize: async () => {
      if (input.conversation) return (await inspectIssueIdentity(intake, provider.client)).item;
      const admission = assignmentIntakePolicy(current.manifest, 'codex');
      if (!admission) throw new WorkflowPolicyHeld('feedback-disabled');
      return (await inspectFeedbackAssignment(admission, intake, provider.client, record)).item;
    },
  });
}
