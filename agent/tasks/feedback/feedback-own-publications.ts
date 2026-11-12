import type { GitHubNotificationPublicationClient } from '../../../channels/github/provider/work-event-client.ts';
import type { DeliveryAnnouncementState } from '../delivery/delivery-announcement-state.ts';
import { reconcileAnnouncement } from '../delivery/delivery-announcement.ts';
import type { ManagedIssue as IntakeRecord } from '../../managed-issue.ts';

/** identify retained public output without publishing or authorizing another reply. */
export default async function feedbackOwnPublications(input: {
  intake: IntakeRecord;
  client: GitHubNotificationPublicationClient;
  announcement?: DeliveryAnnouncementState;
  replies?: () => Promise<string[]>;
}) {
  const { intake, client, announcement } = input;
  const ids: string[] = [];
  if (input.replies) ids.push(...(await input.replies()));
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
