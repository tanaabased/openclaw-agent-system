import type GitHubWorkEventClient from './work-event-client.ts';
import type { GitHubIssueCommentReceipt } from './work-event-client.ts';
import type { GitHubNotificationItemState } from '../utils/monitor-state.ts';
import {
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  type GitHubNotificationPublicationIntent,
} from '../utils/publication.ts';

type PublicationItem = Pick<
  GitHubNotificationItemState,
  'lifecycleId' | 'number' | 'repositoryName' | 'repositoryNodeId' | 'repositoryOwner'
>;

export interface GitHubNotificationCommentPublicationInput {
  intent: GitHubNotificationPublicationIntent;
  item: PublicationItem;
  publicationId: string;
  text: string;
}

export interface GitHubNotificationCommentPublicationAuthorization {
  authorized: boolean;
  reasonCode?: string;
}

export interface GitHubNotificationCommentPublisherDependencies {
  authorize(
    input: Omit<GitHubNotificationCommentPublicationInput, 'text'> & { target: string },
  ):
    | GitHubNotificationCommentPublicationAuthorization
    | Promise<GitHubNotificationCommentPublicationAuthorization>;
  connect():
    | Pick<GitHubWorkEventClient, 'createIssueComment' | 'findOwnIssueComment'>
    | Promise<Pick<GitHubWorkEventClient, 'createIssueComment' | 'findOwnIssueComment'>>;
  exclusive<T>(key: string, run: () => Promise<T>): Promise<T>;
}

export interface GitHubNotificationCommentPublicationResult {
  receipt: GitHubIssueCommentReceipt;
  status: 'published' | 'reconciled';
  target: string;
}

export class GitHubNotificationCommentPublisherError extends Error {
  override name = 'GitHubNotificationCommentPublisherError';

  constructor(readonly code: string) {
    super('The GitHub notification comment could not be published.');
  }
}

/** Reauthorize, reconcile, and publish one sanitized GitHub comment under an exclusive target. */
export default class GitHubNotificationCommentPublisher {
  readonly #dependencies: GitHubNotificationCommentPublisherDependencies;

  constructor(dependencies: GitHubNotificationCommentPublisherDependencies) {
    this.#dependencies = dependencies;
  }

  async publish(
    input: GitHubNotificationCommentPublicationInput,
  ): Promise<GitHubNotificationCommentPublicationResult> {
    const text = githubNotificationPublicationText(input.intent, [{ text: input.text }]);
    const target = githubNotificationPublicationTarget(input);
    return this.#dependencies.exclusive(target, async () => {
      const authorization = await this.#dependencies.authorize({
        intent: input.intent,
        item: input.item,
        publicationId: input.publicationId,
        target,
      });
      if (!authorization.authorized) {
        throw new GitHubNotificationCommentPublisherError(
          authorization.reasonCode ?? 'github-notification-publication-authority-revoked',
        );
      }
      const client = await this.#dependencies.connect();
      const marker = githubNotificationPublicationMarker(target);
      const existing = await client.findOwnIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        marker,
      );
      if (existing) return { receipt: existing, status: 'reconciled', target };
      const receipt = await client.createIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        githubNotificationPublicationComment(text, marker),
      );
      return { receipt, status: 'published', target };
    });
  }
}
