import type { ClaimClient, ClaimSource } from '../../../agent/assignment-claim.ts';
import type { GitHubCanonicalIssueComment } from './comment-admission.ts';
import GitHubIssueCommentClient from './issue-comment-client.ts';
import GitHubWorkEventApiClient, { githubRepositoryEndpoint } from './work-event-api-client.ts';
import type GitHubWorkEventClient from './work-event-client.ts';

/** fixed provider operations; the runtime still owns policy, capacity, passes and creation. */
export default class GitHubAssignmentClaimClient implements ClaimClient {
  readonly #api: GitHubWorkEventApiClient;
  readonly #comments: GitHubIssueCommentClient;

  constructor(readonly client: GitHubWorkEventClient) {
    this.#api = new GitHubWorkEventApiClient(client.account);
    this.#comments = new GitHubIssueCommentClient(this.#api, 2048);
  }

  async verify(source: ClaimSource) {
    if (this.client.identity.nodeId !== source.receivingNodeId)
      throw new Error('claim-receiving-account-mismatch');
    const repository = await this.client.getRepository(source.owner, source.repository);
    if (repository.nodeId !== source.repositoryNodeId || repository.archived || repository.disabled)
      throw new Error('claim-repository-changed');
    const item = await this.client.getItem(source.owner, source.repository, source.number);
    if (
      item.nodeId !== source.issueNodeId ||
      item.itemType !== 'issue' ||
      item.state !== 'open' ||
      !item.assignees.some(({ nodeId }) => nodeId === source.receivingNodeId)
    )
      throw new Error('claim-assignment-changed');
    const history = await this.client.listAssignmentEvents(
      source.owner,
      source.repository,
      source.number,
    );
    if (history.truncated) throw new Error('claim-assignment-history-incomplete');
    const latest = history.events
      .filter((event) => event.assignee.nodeId === source.receivingNodeId)
      .sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
      )[0];
    if (
      latest?.nodeId !== source.assignmentEventId ||
      latest.event !== 'assigned' ||
      latest.actor.nodeId !== source.assignerNodeId ||
      latest.actor.type !== 'User'
    )
      throw new Error('claim-assignment-changed');
  }

  async list(source: ClaimSource): Promise<GitHubCanonicalIssueComment[]> {
    const comments: GitHubCanonicalIssueComment[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.#comments.listIssueCommentPage(
        source.owner,
        source.repository,
        source.number,
        page,
        '1970-01-01T00:00:00Z',
      );
      comments.push(...result.comments);
      if (!result.truncated) return comments;
    }
    throw new Error('claim-comments-incomplete');
  }

  async create(source: ClaimSource, body: string) {
    await this.verify(source);
    return (
      await this.#comments.createIssueComment(source.owner, source.repository, source.number, body)
    ).databaseId;
  }

  async #current(source: ClaimSource, commentId: number, previousBody: string) {
    await this.verify(source);
    const current = await this.#comments.getIssueComment(
      source.owner,
      source.repository,
      source.number,
      commentId,
    );
    if (
      current.author?.nodeId !== source.receivingNodeId ||
      current.bodyTruncated ||
      current.body !== previousBody
    )
      throw new Error('claim-comment-changed');
    return `${githubRepositoryEndpoint(source.owner, source.repository)}/issues/comments/${commentId}`;
  }

  async update(source: ClaimSource, commentId: number, previousBody: string, body: string) {
    const endpoint = await this.#current(source, commentId, previousBody);
    await this.#api.request(
      ['--method', 'PATCH', endpoint, '--input', '-'],
      'claim update',
      JSON.stringify({ body }),
    );
    const current = await this.#comments.getIssueComment(
      source.owner,
      source.repository,
      source.number,
      commentId,
    );
    if (current.body !== body || current.author?.nodeId !== source.receivingNodeId)
      throw new Error('claim-update-unconfirmed');
  }

  async remove(source: ClaimSource, commentId: number, previousBody: string) {
    const endpoint = await this.#current(source, commentId, previousBody);
    await this.#api.request(['--method', 'DELETE', endpoint], 'claim cleanup');
  }
}
