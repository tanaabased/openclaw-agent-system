import type {
  GitHubIssueCommentReceipt,
  GitHubNotificationPublicationClient,
} from '../provider/work-event-client.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import {
  githubNotificationAttributedReplyText,
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  type GitHubNotificationPublicationSource,
} from './publication.ts';

type PublicationItem = Pick<
  GitHubNotificationItemState,
  'lifecycleId' | 'number' | 'repositoryName' | 'repositoryNodeId' | 'repositoryOwner'
>;

export type GitHubNotificationCommentPublicationInput = {
  item: PublicationItem;
  text: string;
} & (
  | {
      intent: 'github-reply';
      source: GitHubNotificationPublicationSource;
    }
  | {
      intent: 'initial-acknowledgment' | 'assignment-response';
      publicationId: string;
    }
);

export interface GitHubNotificationCommentPublicationAuthorization {
  authorized: boolean;
  reasonCode?: string;
}

export interface GitHubNotificationCommentPublicationConnection {
  client: Pick<GitHubNotificationPublicationClient, 'createIssueComment' | 'findOwnIssueComment'>;
  commenterLogin?: string;
}

export interface GitHubNotificationCommentPublisherDependencies {
  authorize(
    input:
      | {
          intent: 'github-reply';
          item: PublicationItem;
          source: GitHubNotificationPublicationSource;
          target: string;
        }
      | {
          intent: 'initial-acknowledgment' | 'assignment-response';
          item: PublicationItem;
          publicationId: string;
          target: string;
        },
  ):
    | GitHubNotificationCommentPublicationAuthorization
    | Promise<GitHubNotificationCommentPublicationAuthorization>;
  connect():
    | GitHubNotificationCommentPublicationConnection
    | Promise<GitHubNotificationCommentPublicationConnection>;
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
    const target =
      input.intent === 'github-reply'
        ? githubNotificationPublicationTarget({
            intent: input.intent,
            item: input.item,
            source: input.source,
          })
        : githubNotificationPublicationTarget({
            intent: input.intent,
            item: input.item,
            publicationId: input.publicationId,
          });
    const marker = githubNotificationPublicationMarker(target);
    return this.#dependencies.exclusive(target, async () => {
      const authorization = await this.#dependencies.authorize(
        input.intent === 'github-reply'
          ? { intent: input.intent, item: input.item, source: input.source, target }
          : {
              intent: input.intent,
              item: input.item,
              publicationId: input.publicationId,
              target,
            },
      );
      if (!authorization.authorized) {
        throw new GitHubNotificationCommentPublisherError(
          authorization.reasonCode ?? 'github-notification-publication-authority-revoked',
        );
      }
      const connection = await this.#dependencies.connect();
      const publicText =
        input.intent === 'github-reply'
          ? githubNotificationAttributedReplyText(
              text,
              connection.commenterLogin ?? missingCommenterLogin(),
            )
          : text;
      const expectedBody = githubNotificationPublicationComment(publicText, marker);
      const existing = await connection.client.findOwnIssueComment(
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
      const receipt = await connection.client.createIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        expectedBody,
      );
      return { receipt, status: 'published', target };
    });
  }
}

function missingCommenterLogin(): never {
  throw new GitHubNotificationCommentPublisherError(
    'github-notification-publication-commenter-missing',
  );
}
