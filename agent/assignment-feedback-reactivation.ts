import feedbackOwnPublications from './feedback-own-publications.ts';
import { feedbackAuthorityDigest, matchesFeedbackAuthority } from './notification-authority.ts';
import type DiscoveryBudget from './discovery-budget.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import type { GitHubNotificationPublicationClient } from '../channels/github/provider/work-event-client.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import type assignmentIntakePolicy from './assignment-intake-policy.ts';
import { inspectAssignedIssue, inspectAssignment } from './dispatch-assignment.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { discoverFeedback } from './feedback-source.ts';
import type { FeedbackSourceState } from './feedback-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationCommentClient,
  GitHubNotificationIntakeClient,
} from '../channels/github/provider/work-event-types.ts';

type Policy = NonNullable<ReturnType<typeof assignmentIntakePolicy>>;

/** feedback custody never grants assessment or implementation authority. */
export async function inspectFeedbackAssignment(
  policy: Policy,
  intake: IntakeRecord,
  client: GitHubNotificationIntakeClient,
  record: SharedDispatchRecord,
) {
  if (!record.feedbackReactivation) return inspectAssignedIssue(policy, intake, client);
  const observation = await inspectAssignment(policy, intake, client);
  const { latest } = observation;
  if (
    latest?.nodeId !== record.feedbackReactivation.assignmentEventId ||
    !matchesFeedbackAuthority(record.feedbackReactivation.policyDigest, policy.policy)
  )
    throw new Error('feedback-reactivation-superseded');
  return observation;
}

export async function revalidateFeedbackAssignment(
  ...input: Parameters<typeof inspectFeedbackAssignment>
) {
  return (await inspectFeedbackAssignment(...input)).repo;
}

/** run before reclamation so an admitted comment can retain the existing conversation. */
export default async function reactivateAssignmentFeedback(input: {
  record: SharedDispatchRecord & { feedback?: FeedbackSourceState };
  intake: IntakeRecord;
  policy: Policy;
  client: GitHubNotificationIntakeClient;
  comments(): Promise<
    GitHubNotificationCommentClient &
      Pick<GitHubNotificationPublicationClient, 'createIssueComment' | 'findOwnIssueComment'>
  >;
  announcement?: DeliveryAnnouncementState;
  now: number;
  budget?: DiscoveryBudget;
  save(): Promise<void>;
  pullRequest?: { number: number; nodeId: string };
}) {
  const { record, intake, policy, client } = input;
  if (
    !feedbackIdentities(
      policy.policy.issueAssignment?.allowed ?? [],
      policy.policy.issueAssignment?.feedback,
    ).length
  ) {
    delete record.feedbackReactivation;
    return false;
  }
  const { latest } = await inspectAssignment(policy, intake, client);
  if (!latest) throw new Error('dispatch-assignment-event-missing');
  const digest = feedbackAuthorityDigest(policy.policy);
  if (
    record.feedbackReactivation?.assignmentEventId === latest.nodeId &&
    matchesFeedbackAuthority(record.feedbackReactivation.policyDigest, policy.policy)
  )
    return true;
  delete record.feedbackReactivation;
  const since = Math.max(
    Date.parse(latest.createdAt),
    record.retirement?.reactivationAfter ??
      (record.retirement?.reason === 'issue-closed' ? record.retirement.at : 0),
  );
  if (!Number.isFinite(since)) throw new Error('dispatch-authority-history-incomplete');
  // discovery uses an exclusive lower bound; include the provider's boundary second.
  const feedback = (record.feedback ??= {
    startedAt: Math.max(0, since - 1),
    baseline: {},
    events: [],
  });
  const comments = await input.comments();
  const targets = [
    { number: intake.issue.number, nodeId: intake.issue.nodeId, itemType: 'issue' as const },
    ...(input.pullRequest ? [{ ...input.pullRequest, itemType: 'pull-request' as const }] : []),
  ];
  let publications: Promise<string[]> | undefined;
  for (const target of targets) {
    if (target.itemType === 'pull-request') {
      const item = await client.getItem(
        intake.repository.owner.login,
        intake.repository.name,
        target.number,
      );
      if (item.nodeId !== target.nodeId || item.itemType !== target.itemType)
        throw new Error('feedback-source-owner-changed');
      if (item.state !== 'open') continue;
    }
    const revisions = await discoverFeedback({
      state: feedback,
      client: comments,
      policy: policy.policy,
      owner: intake.repository.owner.login,
      name: intake.repository.name,
      ...target,
      now: input.now,
      ...(input.budget ? { discovery: { budget: input.budget, save: input.save } } : {}),
      ownCommentIds: () =>
        (publications ??= feedbackOwnPublications({
          record,
          intake,
          client: comments,
          announcement: input.announcement,
        })),
    });
    const event = feedback.events.find(
      (event) =>
        event.nodeId === target.nodeId &&
        event.phase === 'queued' &&
        event.createdAt >= since &&
        matchesFeedbackAuthority(event.policyDigest, policy.policy) &&
        revisions.get(event.sourceId) === event.revision,
    );
    if (event) {
      record.feedbackReactivation = {
        eventId: event.id,
        assignmentEventId: latest.nodeId,
        policyDigest: digest,
        at: input.now,
      };
      await input.save();
      return true;
    }
  }
  await input.save();
  return false;
}
