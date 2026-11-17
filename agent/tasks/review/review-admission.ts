import { Type, type Static } from 'typebox';

import { intakeRecordSchema } from '../../../channels/github/intake/record-store.ts';
import type { GitHubReviewRequestEvent } from '../../../channels/github/provider/review-request-client.ts';
import {
  type GitHubCanonicalWorkItem,
  type GitHubIdentity,
  type GitHubRepositoryIdentity,
  githubIdentityMatches,
} from '../../../channels/github/provider/work-item.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import { automationHash } from '../../automation-hash.ts';
import { selectedProfileSchema } from '../../models/model-routing.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const identity = Type.Object(
  { login: text, nodeId: text, type: Type.Literal('User') },
  { additionalProperties: false },
);
export const reviewAdmissionSchema = Type.Object(
  {
    ...Type.Pick(intakeRecordSchema, [
      'id',
      'scope',
      'workspaceDir',
      'agentId',
      'receiving',
      'repository',
      'issue',
      'admittedAt',
    ]).properties,
    origin: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('request'),
          eventId: text,
          databaseId: Type.Integer({ minimum: 1 }),
          createdAt: text,
          requester: identity,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal('operator'), session: text, turn: text, input: text },
        { additionalProperties: false },
      ),
    ]),
    author: Type.Object(
      { login: text, nodeId: text, type: Type.Union([Type.Literal('User'), Type.Literal('Bot')]) },
      { additionalProperties: false },
    ),
    head: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
    baseRef: text,
    selections: Type.Optional(Type.Partial(selectedProfileSchema)),
  },
  { additionalProperties: false },
);
export type ReviewAdmission = Static<typeof reviewAdmissionSchema>;

/** author and reviewer ownership cannot collide even on the same provider item. */
export function reviewKey(
  admission: Pick<ReviewAdmission, 'scope' | 'repository' | 'issue' | 'receiving'>,
) {
  return automationHash({
    role: 'reviewer',
    scope: admission.scope,
    repository: admission.repository.nodeId,
    item: admission.issue.nodeId,
    reviewer: admission.receiving.nodeId,
  });
}

/** provider evidence establishes request authority; CI readiness does not grant it. */
export function admitReview(
  input: {
    scope: string;
    workspaceDir: string;
    agentId: string;
    identity: GitHubIdentity;
    repository: GitHubRepositoryIdentity;
    item: GitHubCanonicalWorkItem;
    policy: GitHubNotificationPolicy;
    now: number;
  } & (
    | { request: GitHubReviewRequestEvent; operator?: never }
    | { request?: never; operator: Extract<ReviewAdmission['origin'], { kind: 'operator' }> }
  ),
): ReviewAdmission {
  const { item, repository, identity: reviewer, request, policy } = input;
  if (!input.operator && (!policy.reviewRequest || policy.reviewRequest.paused))
    throw new Error('review-request-disabled');
  if (item.itemType !== 'pull-request' || item.state !== 'open' || item.pullRequest.merged)
    throw new Error('review-open-pull-request-required');
  if (
    repository.archived ||
    repository.disabled ||
    item.pullRequest.baseRepositoryNodeId !== repository.nodeId
  )
    throw new Error('review-repository-unavailable');
  if (
    reviewer.type !== 'User' ||
    (request && (request.requester.type !== 'User' || request.reviewer.type !== 'User')) ||
    !item.pullRequest.author ||
    !['User', 'Bot'].includes(item.pullRequest.author.type)
  )
    throw new Error('review-request-identity-unsupported');
  if (
    request &&
    (request.event !== 'review_requested' || !githubIdentityMatches(request.reviewer, reviewer))
  )
    throw new Error('review-request-receiver-mismatch');
  if (githubIdentityMatches(item.pullRequest.author, reviewer))
    throw new Error('review-self-review-disallowed');
  if (
    request &&
    !policy.reviewRequest!.allowed.some((actor) => githubIdentityMatches(actor, request.requester))
  )
    throw new Error('review-request-requester-unapproved');
  if (!input.operator && repositoryScope(policy, repository, 'review-request').decision === 'deny')
    throw new Error('review-request-repository-excluded');
  const admission: ReviewAdmission = {
    id: automationHash({
      role: 'reviewer',
      scope: input.scope,
      repository: repository.nodeId,
      item: item.nodeId,
      reviewer: reviewer.nodeId,
      request: request?.nodeId,
      operator: input.operator,
    }),
    scope: input.scope,
    workspaceDir: input.workspaceDir,
    agentId: input.agentId,
    receiving: { login: reviewer.login, nodeId: reviewer.nodeId },
    repository: {
      nodeId: repository.nodeId,
      databaseId: repository.databaseId,
      name: repository.name,
      owner: { login: repository.owner.login, nodeId: repository.owner.nodeId },
    },
    issue: { nodeId: item.nodeId, databaseId: item.databaseId, number: item.number },
    admittedAt: input.now,
    origin: input.operator ?? {
      kind: 'request',
      eventId: request!.nodeId,
      databaseId: request!.databaseId,
      createdAt: request!.createdAt,
      requester: { ...request!.requester, type: 'User' },
    },
    author: {
      ...item.pullRequest.author,
      type: item.pullRequest.author.type === 'Bot' ? 'Bot' : 'User',
    },
    head: item.pullRequest.headSha,
    baseRef: item.pullRequest.baseRef,
  };
  return admission;
}
