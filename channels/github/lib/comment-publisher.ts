import type GitHubWorkEventClient from './work-event-client.ts';
import type { GitHubIssueCommentReceipt } from './work-event-client.ts';
import type { GitHubNotificationItemState } from '../utils/monitor-state.ts';
import {
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  type GitHubNotificationPublicationSource,
} from '../utils/publication.ts';

type PublicationItem = Pick<
  GitHubNotificationItemState,
  'lifecycleId' | 'number' | 'repositoryName' | 'repositoryNodeId' | 'repositoryOwner'
>;

export interface GitHubNotificationCommentPublicationInput {
  intent: 'github-reply';
  item: PublicationItem;
  source: GitHubNotificationPublicationSource;
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
    const result = await this.#execute(input, true);
    if (!result) {
      throw new GitHubNotificationCommentPublisherError(
        'github-notification-publication-not-confirmed',
      );
    }
    return result;
  }

  async reconcile(
    input: GitHubNotificationCommentPublicationInput,
  ): Promise<GitHubNotificationCommentPublicationResult | undefined> {
    return this.#execute(input, false);
  }

  async #execute(
    input: GitHubNotificationCommentPublicationInput,
    create: boolean,
  ): Promise<GitHubNotificationCommentPublicationResult | undefined> {
    const text = githubNotificationPublicationText(input.intent, [{ text: input.text }]);
    const target = githubNotificationPublicationTarget({
      intent: input.intent,
      item: input.item,
      source: input.source,
    });
    const marker = githubNotificationPublicationMarker(target);
    const expectedBody = githubNotificationPublicationComment(text, marker);
    return this.#dependencies.exclusive(target, async () => {
      const authorization = await this.#dependencies.authorize({
        intent: input.intent,
        item: input.item,
        source: input.source,
        target,
      });
      if (!authorization.authorized) {
        throw new GitHubNotificationCommentPublisherError(
          authorization.reasonCode ?? 'github-notification-publication-authority-revoked',
        );
      }
      const client = await this.#dependencies.connect();
      const existing = await client.findOwnIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        marker,
      );
      if (existing) {
        if (existing.body !== expectedBody) {
          throw new GitHubNotificationCommentPublisherError(
            'github-notification-publication-reconciliation-conflict',
          );
        }
        return { receipt: existing, status: 'reconciled', target };
      }
      if (!create) return undefined;
      const receipt = await client.createIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        expectedBody,
      );
      return { receipt, status: 'published', target };
    });
  }
}
