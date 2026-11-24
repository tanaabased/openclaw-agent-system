import {
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import {
  githubResponseIdentity,
  githubResponseNodeId,
  githubResponsePositiveInteger,
  githubResponseRecord,
  githubResponseTimestamp,
} from './work-event-normalization.ts';
import { githubIdentityMatches, type GitHubIdentity } from './work-item.ts';

export interface GitHubReviewRequestEvent {
  nodeId: string;
  databaseId: number;
  createdAt: string;
  event: 'review_requested' | 'review_request_removed';
  requester: GitHubIdentity;
  reviewer: GitHubIdentity;
}

export default class GitHubReviewRequestClient {
  constructor(private readonly api: Pick<GitHubWorkEventApiClient, 'request' | 'identity'>) {}

  async current(owner: string, name: string, number: number) {
    let requested = false;
    for (let page = 1; ; page++) {
      const response = await this.api.request(
        [
          `${githubRepositoryEndpoint(owner, name)}/pulls/${number}/requested_reviewers`,
          '--method',
          'GET',
          '-F',
          'per_page=100',
          '-F',
          `page=${page}`,
        ],
        'requested reviewers',
      );
      const current = githubResponseRecord(response.value, 'requested reviewers');
      if (!Array.isArray(current.users)) throw new Error('review-request-membership-incomplete');
      requested ||= current.users.some((raw) => {
        const user = githubResponseRecord(raw, 'requested reviewer');
        return githubIdentityMatches(
          githubResponseIdentity({ ...user, nodeId: user.node_id }, 'requested reviewer'),
          this.api.identity,
        );
      });
      if (!response.hasNextPage) break;
    }
    if (!requested) return undefined;
    const latest = await this.latest(owner, name, number);
    if (!latest || latest.event !== 'review_requested')
      throw new Error('review-request-origin-unavailable');
    if (latest.requester.type !== 'User' || latest.reviewer.type !== 'User')
      throw new Error('review-request-identity-unsupported');
    return latest;
  }

  async latest(owner: string, name: string, number: number) {
    const endpoint = githubWorkItemEndpoint(owner, name, number);
    let latest: GitHubReviewRequestEvent | undefined;
    // Pages are consumed to completion: an older request cannot authorize a later re-request.
    for (let page = 1; ; page++) {
      const history = await this.api.request(
        [
          '--method',
          'GET',
          `${endpoint}/events`,
          '-F',
          'per_page=100',
          '-F',
          `page=${page}`,
          '--jq',
          '[.[]|select(.event=="review_requested" or .event=="review_request_removed")|{id,node_id,event,created_at,requested_reviewer,review_requester,actor}]',
        ],
        'review request history',
      );
      if (!Array.isArray(history.value)) throw new Error('review-request-history-invalid');
      for (const raw of history.value) {
        const value = githubResponseRecord(raw, 'review request event');
        if (!value.requested_reviewer) continue;
        const user = githubResponseRecord(value.requested_reviewer, 'requested reviewer');
        const reviewer = githubResponseIdentity(
          { ...user, nodeId: user.node_id },
          'requested reviewer',
        );
        if (!githubIdentityMatches(reviewer, this.api.identity)) continue;
        const actor = githubResponseRecord(
          value.event === 'review_request_removed'
            ? (value.actor ?? value.review_requester)
            : value.review_requester,
          'review requester',
        );
        const requester = githubResponseIdentity(
          { ...actor, nodeId: actor.node_id },
          'review requester',
        );
        if (value.event !== 'review_requested' && value.event !== 'review_request_removed')
          throw new Error('review-request-history-invalid');
        const event: GitHubReviewRequestEvent = {
          nodeId: githubResponseNodeId(value.node_id, 'review request event'),
          databaseId: githubResponsePositiveInteger(value.id, 'review request event'),
          createdAt: githubResponseTimestamp(value.created_at, 'review request event'),
          event: value.event,
          requester,
          reviewer,
        };
        if (
          !latest ||
          Date.parse(event.createdAt) > Date.parse(latest.createdAt) ||
          (event.createdAt === latest.createdAt && event.databaseId > latest.databaseId)
        )
          latest = event;
      }
      if (!history.hasNextPage) break;
    }
    return latest;
  }
}
