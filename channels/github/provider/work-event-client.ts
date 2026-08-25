import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';
import type { GitHubCanonicalIssueComment } from '../conversation/comment-admission.ts';
import type { GitHubRateLimit } from './api-response.ts';
import GitHubIssueCommentClient from './issue-comment-client.ts';
import GitHubWorkEventApiClient from './work-event-api-client.ts';
import type {
  GitHubAssignedItemDiscovery,
  GitHubIssueCommentPage,
  GitHubIssueCommentReceipt,
  GitHubIssueCommentReconciliationReceipt,
  GitHubNotificationItemContext,
  GitHubNotificationProviderClient,
} from './work-event-types.ts';
import GitHubWorkItemClient from './work-item-client.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubIdentity,
  GitHubRepositoryIdentity,
  GitHubRepositoryPermission,
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
  readonly #api: GitHubWorkEventApiClient;
  readonly #comments: GitHubIssueCommentClient;
  readonly #items: GitHubWorkItemClient;

  constructor(client: ConnectedGitHubAccountClient) {
    this.#api = new GitHubWorkEventApiClient(client);
    this.#comments = new GitHubIssueCommentClient(this.#api);
    this.#items = new GitHubWorkItemClient(this.#api);
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
  ): Promise<GitHubAssignedItemDiscovery> {
    return this.#items.discoverAssigned(updatedSince, assignmentTypes);
  }

  getRepository(owner: string, name: string): Promise<GitHubRepositoryIdentity> {
    return this.#items.getRepository(owner, name);
  }

  getPermission(owner: string, name: string, login: string): Promise<GitHubRepositoryPermission> {
    return this.#items.getPermission(owner, name, login);
  }

  getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem> {
    return this.#items.getItem(owner, name, number);
  }

  getItemContext(
    owner: string,
    name: string,
    number: number,
    itemType: 'issue' | 'pull-request' = 'issue',
  ): Promise<GitHubNotificationItemContext> {
    return this.#items.getItemContext(owner, name, number, itemType);
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
