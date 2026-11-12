import taskPullRequest from '../delivery/task-pull-request.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import type { GitHubNotificationProviderClient } from '../../../channels/github/provider/work-event-types.ts';
import type { GitHubCanonicalWorkItem } from '../../../channels/github/provider/work-item.ts';
import {
  isReviewFeedback,
  readReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../../../channels/github/provider/review-feedback.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { admitFeedback, feedbackRevision } from './feedback-source.ts';
import { WorkflowPolicyHeld } from '../live-workflow-policy.ts';
import type { ManagedIssue as IntakeRecord } from '../managed-issue.ts';

/** source authority is rechecked before context and every publication effect. */
export default async function authorizeFeedback(input: {
  conversation?: boolean;
  record: Parameters<typeof taskPullRequest>[0];
  event: Pick<FeedbackSourceEvent, 'number' | 'nodeId' | 'itemType' | 'source' | 'revision'>;
  policy: GitHubNotificationPolicy;
  provider: Pick<
    GitHubNotificationProviderClient,
    'identity' | 'reviews' | 'getItem' | 'getIssueComment'
  >;
  intake: IntakeRecord;
  assertCurrent(): Promise<void>;
  reauthorize?: () => Promise<GitHubCanonicalWorkItem | void>;
  livePolicy?(): Promise<GitHubNotificationPolicy>;
}) {
  const { record, event, provider, intake } = input;
  await input.assertCurrent();
  const pullRequest = taskPullRequest(record);
  const owner = intake.repository.owner.login,
    name = intake.repository.name;
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  const assignment = await input.reauthorize?.();
  const item =
    assignment && event.number === intake.issue.number
      ? assignment
      : await provider.getItem(owner, name, event.number);
  if (
    item.nodeId !== event.nodeId ||
    item.itemType !== event.itemType ||
    (!input.conversation && item.state !== 'open') ||
    (event.itemType === 'issue' && event.nodeId !== intake.issue.nodeId) ||
    (!input.conversation &&
      event.itemType === 'pull-request' &&
      (pullRequest?.pullRequestNodeId !== event.nodeId ||
        pullRequest.pullRequestNumber !== event.number))
  )
    throw new Error('feedback-source-owner-changed');
  if (isReviewFeedback(source) && !provider.reviews)
    throw new Error('feedback-review-client-missing');
  const exact = isReviewFeedback(source)
    ? await readReviewFeedback(
        provider.reviews!,
        owner,
        name,
        event.number,
        source.databaseId,
        source.feedback.receipt,
      )
    : await provider.getIssueComment(owner, name, event.number, source.databaseId);
  if (exact.nodeId !== source.nodeId) throw new Error('feedback-source-identity-changed');
  if (exact.author?.nodeId !== source.author?.nodeId)
    throw new Error('feedback-source-author-changed');
  if (feedbackRevision(exact) !== event.revision) throw new Error('feedback-source-changed');
  if (
    admitFeedback((await input.livePolicy?.()) ?? input.policy, provider.identity, exact)
      .disposition !== 'approved'
  )
    throw new WorkflowPolicyHeld('feedback-not-approved');
  return source;
}
