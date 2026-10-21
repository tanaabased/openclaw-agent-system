import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { inspectFeedbackAssignment } from './assignment-feedback-reactivation.ts';
import { admitFeedback, feedbackRevision } from './feedback-source.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type connectCodexFeedback from './codex-feedback-client.ts';
import type { selectCodexIntake } from './codex-intake.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import {
  isReviewFeedback,
  readReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';

/** verify the exact admitted source before work and every dependent provider write. */
export default async function authorizeCodexFeedback(input: {
  current: Awaited<ReturnType<typeof selectCodexIntake>>;
  record: DispatchRecord;
  event: FeedbackSourceEvent;
  intake: IntakeRecord;
  provider: Awaited<ReturnType<typeof connectCodexFeedback>>;
}) {
  const { current, record, event, intake, provider } = input;
  const policy = assignmentIntakePolicy(current.manifest, 'codex');
  if (!policy) throw new WorkflowPolicyHeld('feedback-disabled');
  const owner = intake.repository.owner.login,
    name = intake.repository.name;
  const assignment = await inspectFeedbackAssignment(policy, intake, provider.client, record);
  const item =
    event.number === intake.issue.number
      ? assignment.item
      : await provider.client.getItem(owner, name, event.number);
  if (
    item.nodeId !== event.nodeId ||
    item.itemType !== event.itemType ||
    item.state !== 'open' ||
    (event.itemType === 'pull-request' &&
      (record.delivery?.pullRequest?.pullRequestNodeId !== event.nodeId ||
        record.delivery.pullRequest.pullRequestNumber !== event.number))
  )
    throw new Error('feedback-source-owner-changed');
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  const exact = isReviewFeedback(source)
    ? await readReviewFeedback(
        provider.comments.reviews,
        owner,
        name,
        event.number,
        source.databaseId,
        source.feedback.receipt,
      )
    : await provider.comments.getIssueComment(owner, name, event.number, source.databaseId);
  if (!exact || exact.nodeId !== source.nodeId) throw new Error('feedback-source-identity-changed');
  if (exact.author?.nodeId !== source.author?.nodeId)
    throw new Error('feedback-source-author-changed');
  if (feedbackRevision(exact) !== event.revision) throw new Error('feedback-source-changed');
  if (
    admitFeedback(current.manifest.github!.notifications!, provider.comments.identity, exact)
      .disposition !== 'approved'
  )
    throw new WorkflowPolicyHeld('feedback-not-approved');
}
