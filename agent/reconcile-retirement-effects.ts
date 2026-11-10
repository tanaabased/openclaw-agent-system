import type { RetirementEffect } from './retirement-effects.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import type IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import type { IssueDeliveryInput } from '../channels/github/publication/issue-delivery.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationInput,
} from '../channels/github/publication/comment-publisher.ts';
import redactFeedback from './feedback-redaction.ts';
import workflowFailure from './workflow-failure.ts';

/** recovery has no write route: absent or changed evidence retains only the original receipt. */
export default async function reconcileRetirementEffects(input: {
  effects: RetirementEffect[];
  comments(): Promise<
    Pick<OpenClawFeedbackProvider, 'identity' | 'getRepository' | 'findOwnIssueComment' | 'replies'>
  >;
  delivery(): Promise<Pick<IssueDeliveryProvider, 'client' | 'retirementOutcome'>>;
  save(): Promise<void>;
}) {
  for (const effect of [...input.effects]) {
    try {
      let settled = false;
      if (effect.kind === 'delivery') {
        const provider = await input.delivery();
        if (provider.client.identity.nodeId !== effect.accountId)
          throw new Error('retirement-effect-account-changed');
        settled = await provider.retirementOutcome(
          JSON.parse(effect.publication) as IssueDeliveryInput,
          effect,
        );
      } else {
        const provider = await input.comments();
        if (provider.identity.nodeId !== effect.accountId)
          throw new Error('retirement-effect-account-changed');
        const publication = JSON.parse(
          effect.publication,
        ) as GitHubNotificationCommentPublicationInput;
        const { item } = publication;
        const repository = await provider.getRepository(item.repositoryOwner, item.repositoryName);
        if (repository.nodeId !== item.repositoryNodeId)
          throw new Error('retirement-effect-repository-changed');
        const publisher = new GitHubNotificationCommentPublisher({
          redactText: redactFeedback,
          authorize: () => ({ authorized: true }),
          exclusive: async (_key, run) => run(),
          connect: () => ({
            commenterLogin: effect.commenterLogin,
            client: {
              createIssueComment: async () => {
                throw new Error('retirement-effect-write-forbidden');
              },
              findOwnIssueComment: (owner, name, number, marker) =>
                effect.reviewRoot
                  ? provider.replies.find(owner, name, number, effect.reviewRoot, marker)
                  : provider.findOwnIssueComment(owner, name, number, marker),
            },
          }),
        });
        settled = Boolean(await publisher.reconcile(publication));
      }
      if (settled)
        input.effects.splice(
          input.effects.findIndex((entry) => entry.id === effect.id),
          1,
        );
      else effect.code = 'retirement-effect-unconfirmed';
    } catch (error) {
      effect.code = workflowFailure(error, 'retirement-effect-observation-unavailable').code;
    }
    await input.save();
  }
}
