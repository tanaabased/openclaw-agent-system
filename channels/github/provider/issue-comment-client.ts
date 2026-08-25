import type { GitHubCanonicalIssueComment } from '../conversation/comment-admission.ts';
import {
  GitHubWorkEventClientError,
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import {
  githubResponseBoundedProse,
  githubResponseIdentity,
  githubResponseIssueComment,
  githubResponseNodeId,
  githubResponsePositiveInteger,
  githubResponseRecord,
  githubResponseString,
  maximumCommentBodyLength,
  maximumPublicationBodyLength,
} from './work-event-normalization.ts';
import type {
  GitHubIssueCommentPage,
  GitHubIssueCommentReceipt,
  GitHubIssueCommentReconciliationReceipt,
  GitHubNotificationCommentClient,
  GitHubNotificationPublicationClient,
} from './work-event-types.ts';
import type { GitHubIdentity } from './work-item.ts';

const pageSize = 100;
const maximumCommentPages = 10;
const maximumTrackedCommentPages = 3;

/** Read and publish bounded top-level issue comments through fixed GitHub endpoints. */
export default class GitHubIssueCommentClient
  implements GitHubNotificationCommentClient, GitHubNotificationPublicationClient
{
  readonly #api: GitHubWorkEventApiClient;

  constructor(api: GitHubWorkEventApiClient) {
    this.#api = api;
  }

  get identity(): GitHubIdentity {
    return this.#api.identity;
  }

  /** List a complete bounded projection of top-level comments through GitHub's issue API. */
  async listIssueComments(
    owner: string,
    name: string,
    number: number,
  ): Promise<GitHubIssueCommentPage> {
    const comments: GitHubCanonicalIssueComment[] = [];
    let hasNextPage = false;
    for (let page = 1; page <= maximumTrackedCommentPages; page += 1) {
      const response = await this.#api.request(
        [
          '--method',
          'GET',
          `${githubWorkItemEndpoint(owner, name, number)}/comments`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          `[.[]|{databaseId:.id,nodeId:.node_id,author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),body:((.body//"")[0:${maximumCommentBodyLength + 1}]),bodyLength:(.body//""|length),createdAt:.created_at,updatedAt:.updated_at}]`,
        ],
        'issue comments',
      );
      if (!Array.isArray(response.value)) {
        throw new Error('GitHub returned invalid issue comments.');
      }
      comments.push(...response.value.map(githubResponseIssueComment));
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) break;
    }
    return { comments, truncated: hasNextPage };
  }

  /** Re-read one exact canonical top-level comment before dispatch or publication. */
  async getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment> {
    if (!Number.isSafeInteger(commentDatabaseId) || commentDatabaseId < 1) {
      throw new Error('GitHub issue-comment database ids must be positive safe integers.');
    }
    const response = await this.#api.request(
      [
        '--method',
        'GET',
        `${githubRepositoryEndpoint(owner, name)}/issues/comments/${commentDatabaseId}`,
        '--jq',
        `{databaseId:.id,nodeId:.node_id,issueUrl:.issue_url,author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),body:((.body//"")[0:${maximumCommentBodyLength + 1}]),bodyLength:(.body//""|length),createdAt:.created_at,updatedAt:.updated_at}`,
      ],
      'issue comment',
    );
    const value = githubResponseRecord(response.value, 'issue comment');
    let issueUrl: URL;
    try {
      issueUrl = new URL(githubResponseString(value.issueUrl, 'issue-comment issue url'));
    } catch {
      throw new Error('GitHub returned an invalid issue-comment issue url.');
    }
    if (
      issueUrl.origin !== 'https://api.github.com' ||
      issueUrl.pathname.toLowerCase() !==
        `${githubRepositoryEndpoint(owner, name)}/issues/${number}`.toLowerCase()
    ) {
      throw new Error('GitHub returned an issue comment for another work item.');
    }
    return githubResponseIssueComment(value);
  }

  async findOwnIssueComment(
    owner: string,
    name: string,
    number: number,
    marker: string,
  ): Promise<GitHubIssueCommentReconciliationReceipt | undefined> {
    if (
      !/^<!-- agent-system-github-publication:(?:assignment-response|github-reply|initial-acknowledgment):[a-f0-9]{32} -->$/u.test(
        marker,
      )
    ) {
      throw new Error('GitHub notification publication markers are invalid.');
    }
    let hasNextPage = false;
    for (let page = 1; page <= maximumCommentPages; page += 1) {
      const response = await this.#api.request(
        [
          '--method',
          'GET',
          `${githubWorkItemEndpoint(owner, name, number)}/comments`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          `[.[]|select(.body|contains(${JSON.stringify(marker)}))|{databaseId:.id,nodeId:.node_id,body:.body,user:{login:.user.login,nodeId:.user.node_id,type:.user.type}}]`,
        ],
        'issue comments',
      );
      if (!Array.isArray(response.value)) {
        throw new Error('GitHub returned invalid issue comments.');
      }
      for (const item of response.value) {
        const value = githubResponseRecord(item, 'issue comment');
        const author = githubResponseIdentity(value.user, 'issue-comment author');
        if (author.nodeId !== this.identity.nodeId) continue;
        return {
          body: githubResponseBoundedProse(
            value.body,
            'issue-comment body',
            maximumPublicationBodyLength,
          ).text,
          databaseId: githubResponsePositiveInteger(value.databaseId, 'issue-comment database id'),
          nodeId: githubResponseNodeId(value.nodeId, 'issue-comment node id'),
        };
      }
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) return undefined;
    }
    if (hasNextPage) {
      throw new GitHubWorkEventClientError(
        'github-notification-comments-truncated',
        'GitHub issue comments exceeded the publication reconciliation boundary.',
        this.#api.rateLimit,
      );
    }
    return undefined;
  }

  async createIssueComment(
    owner: string,
    name: string,
    number: number,
    body: string,
  ): Promise<GitHubIssueCommentReceipt> {
    if (!body || body.length > 1_024 || /\0/u.test(body)) {
      throw new Error('GitHub notification publication comments are invalid.');
    }
    const response = await this.#api.request(
      [
        '--method',
        'POST',
        `${githubWorkItemEndpoint(owner, name, number)}/comments`,
        '--input',
        '-',
        '--jq',
        '{databaseId:.id,nodeId:.node_id,body,user:{login:.user.login,nodeId:.user.node_id,type:.user.type}}',
      ],
      'issue-comment publication',
      JSON.stringify({ body }),
    );
    const value = githubResponseRecord(response.value, 'published issue comment');
    const author = githubResponseIdentity(value.user, 'published issue-comment author');
    if (
      author.nodeId !== this.identity.nodeId ||
      githubResponseString(value.body, 'published issue-comment body') !== body
    ) {
      throw new Error('GitHub returned a conflicting published issue comment.');
    }
    return {
      databaseId: githubResponsePositiveInteger(
        value.databaseId,
        'published issue-comment database id',
      ),
      nodeId: githubResponseNodeId(value.nodeId, 'published issue-comment node id'),
    };
  }
}
