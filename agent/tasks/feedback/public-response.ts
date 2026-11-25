import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationInput,
  type GitHubNotificationCommentPublisherDependencies,
} from '../../../channels/github/publication/comment-publisher.ts';

export interface PublicResponseReceipt {
  nodeId: string;
  databaseId: number;
}

/** native owners retain source authority and serialize their existing durable records. */
export default async function publicResponse(input: {
  publication: GitHubNotificationCommentPublicationInput;
  attempted: boolean;
  receipt?: PublicResponseReceipt;
  reconcileOnly?: boolean;
  dependencies: Omit<
    GitHubNotificationCommentPublisherDependencies,
    'beforeCreate' | 'onCreateRejected'
  >;
  beforeCreate?(): Promise<void>;
  setAttempted(attempted: boolean): void;
  setReceipt(receipt: PublicResponseReceipt): void;
  save(): Promise<void>;
}) {
  async function saveAttempt(attempted: boolean) {
    input.setAttempted(attempted);
    try {
      await input.save();
    } catch (error) {
      input.setAttempted(!attempted);
      throw error;
    }
  }
  const publisher = new GitHubNotificationCommentPublisher({
    ...input.dependencies,
    beforeCreate: async () => {
      await input.beforeCreate?.();
      await saveAttempt(true);
    },
    onCreateRejected: () => saveAttempt(false),
  });
  // an attempted effect is observation-only even when a later caller asks to publish.
  const result =
    input.attempted || input.receipt || input.reconcileOnly
      ? await publisher.reconcile(input.publication)
      : await publisher.publish(input.publication);
  if (!result) return { status: 'uncertain' as const };
  if (input.receipt && input.receipt.nodeId !== result.receipt.nodeId)
    throw new Error('github-notification-publication-reconciliation-conflict');
  const receipt = { nodeId: result.receipt.nodeId, databaseId: result.receipt.databaseId };
  input.setReceipt(receipt);
  await input.save();
  return { status: 'published' as const, receipt };
}
