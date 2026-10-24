import { assessmentSummaryOwnPublications } from './assessment-summary.ts';
import { reconcileAnnouncement } from './delivery-announcement.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import redactFeedback from './feedback-redaction.ts';
import type { ManagedIssue as IntakeRecord } from './managed-issue.ts';
import type { GitHubNotificationPublicationClient } from '../channels/github/provider/work-event-client.ts';

/** identify retained public output without publishing or authorizing another reply. */
export default async function feedbackOwnPublications(input: {
  record: SharedDispatchRecord;
  intake: IntakeRecord;
  client: GitHubNotificationPublicationClient;
  announcement?: DeliveryAnnouncementState;
}) {
  const { record, intake, client, announcement } = input;
  const ids = await assessmentSummaryOwnPublications(record, intake, { client }, redactFeedback);
  if (announcement?.receipt) ids.push(announcement.receipt.nodeId);
  else if (announcement?.attempted) {
    const receipt = await reconcileAnnouncement({
      state: announcement,
      client,
      authorId: client.identity.nodeId,
      item: {
        lifecycleId: 'issue',
        number: intake.issue.number,
        repositoryOwner: intake.repository.owner.login,
        repositoryName: intake.repository.name,
        repositoryNodeId: intake.repository.nodeId,
      },
    });
    ids.push(receipt.nodeId);
  }
  return ids;
}
