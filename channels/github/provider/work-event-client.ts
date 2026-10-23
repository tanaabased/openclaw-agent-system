import GitHubReviewReplyClient from './review-reply-client.ts';
import GitHubReviewClient from './review-client.ts';
import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';
import type { GitHubCanonicalIssueComment } from './comment-admission.ts';
import type { GitHubRateLimit } from './api-response.ts';
import GitHubIssueCommentClient from './issue-comment-client.ts';
import readItemContext from './read-item-context.ts';
import GitHubWorkEventApiClient from './work-event-api-client.ts';
import retryGitHubRead from '../../../core/github-read-retry.ts';
import type {
  GitHubAssignedItemDiscovery,
  GitHubIssueCommentPage,
  GitHubIssueCommentReceipt,
  GitHubIssueCommentReconciliationReceipt,
  GitHubNotificationItemContext,
  GitHubNotificationProviderClient,
} from './work-event-types.ts';
import GitHubWorkItemClient from './work-item-client.ts';
import {
  defaultMaximumCommentCharacters,
  validateMaximumCommentCharacters,
} from './comment-limit.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubIdentity,
  GitHubRepositoryIdentity,
} from './work-item.ts';

export { GitHubWorkEventClientError } from './work-event-api-client.ts';
export type {
  GitHubAssignedItemDiscovery,
  GitHubIssueCommentPage,
  GitHubIssueCommentReceipt,
  GitHubIssueCommentReconciliationReceipt,
  GitHubNotificationCommentClient,
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
  GitHubNotificationItemContext,
  GitHubNotificationItemContextComment,
  GitHubNotificationItemContextFile,
  GitHubNotificationProviderClient,
  GitHubNotificationPublicationClient,
} from './work-event-types.ts';

/** Fixed-endpoint, bounded GitHub access for notification control facts and publication. */
export default class GitHubWorkEventClient implements GitHubNotificationProviderClient {
  readonly reviews: GitHubReviewClient;
  readonly replies: GitHubReviewReplyClient;
  readonly #api: GitHubWorkEventApiClient;
  readonly #comments: GitHubIssueCommentClient;
  readonly #items: GitHubWorkItemClient;
  readonly maximumCommentCharacters: number;

  constructor(
    readonly account: ConnectedGitHubAccountClient,
    maximumCommentCharacters = defaultMaximumCommentCharacters,
    retryRead = retryGitHubRead,
  ) {
    this.maximumCommentCharacters = validateMaximumCommentCharacters(maximumCommentCharacters);
    this.#api = new GitHubWorkEventApiClient(account, retryRead);
    this.reviews = new GitHubReviewClient(this.#api, this.maximumCommentCharacters);
    this.replies = new GitHubReviewReplyClient(this.#api, this.reviews);
    this.#comments = new GitHubIssueCommentClient(this.#api, this.maximumCommentCharacters);
    this.#items = new GitHubWorkItemClient(this.#api);
  }

  listIssueCommentPage(owner: string, name: string, number: number, page: number, since: string) {
    return this.#comments.listIssueCommentPage(owner, name, number, page, since);
  }

  resolveIdentity(reference: string) {
    return this.#items.resolveIdentity(reference);
  }

  resolveIdentities(references: readonly string[]) {
    return this.#items.resolveIdentities(references);
  }

  get identity(): GitHubIdentity {
    return this.#api.identity;
  }

  get rateLimit(): GitHubRateLimit {
    return this.#api.rateLimit;
  }

  discoverAssigned(
    updatedSince: string,
    assignmentTypes: readonly ('issue' | 'pull-request')[],
    page?: number,
  ): Promise<GitHubAssignedItemDiscovery> {
    return this.#items.discoverAssigned(updatedSince, assignmentTypes, page);
  }

  getRepository(owner: string, name: string): Promise<GitHubRepositoryIdentity> {
    return this.#items.getRepository(owner, name);
  }

  getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem> {
    return this.#items.getItem(owner, name, number);
  }

  getItemContext(
    owner: string,
    name: string,
    number: number,
    itemType: 'issue' | 'pull-request' = 'issue',
    includeRoutingMetadata = false,
  ): Promise<GitHubNotificationItemContext> {
    return readItemContext(this.#api, owner, name, number, itemType, includeRoutingMetadata);
  }

  listAssignmentEvents(
    owner: string,
    name: string,
    number: number,
  ): Promise<{ events: GitHubAssignmentEvent[]; truncated: boolean }> {
    return this.#items.listAssignmentEvents(owner, name, number);
  }

  listIssueComments(owner: string, name: string, number: number): Promise<GitHubIssueCommentPage> {
    return this.#comments.listIssueComments(owner, name, number);
  }

  getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment> {
    return this.#comments.getIssueComment(owner, name, number, commentDatabaseId);
  }

  findOwnIssueComment(
    owner: string,
    name: string,
    number: number,
    marker: string,
  ): Promise<GitHubIssueCommentReconciliationReceipt | undefined> {
    return this.#comments.findOwnIssueComment(owner, name, number, marker);
  }

  createIssueComment(
    owner: string,
    name: string,
    number: number,
    body: string,
  ): Promise<GitHubIssueCommentReceipt> {
    return this.#comments.createIssueComment(owner, name, number, body);
  }
}
