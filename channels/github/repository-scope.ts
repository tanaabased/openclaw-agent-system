import { Type, type Static } from 'typebox';

import { githubIdentityMatches } from './provider/work-item.ts';
import type { GitHubNotificationPolicy } from './workflow-policy.ts';

// only segment-local stars are supported; do not interpret general glob syntax.
export const repositoryPatternSchema = Type.String({
  minLength: 3,
  pattern: '^!?(?!.*\\*\\*)[A-Za-z0-9*.-]+/[A-Za-z0-9*_.-]+(?![\\s\\S])',
});
export const repositoryRouteSchema = Type.Union([
  repositoryPatternSchema,
  Type.Record(
    Type.String({ pattern: '^(?!!)(?!.*\\*\\*)[A-Za-z0-9*.-]+/[A-Za-z0-9*_.-]+(?![\\s\\S])' }),
    Type.Union([Type.Literal('local'), Type.Literal('swarm')]),
    { minProperties: 1, maxProperties: 1, additionalProperties: false },
  ),
]);
export type RepositoryRoute = Static<typeof repositoryRouteSchema>;

export const repositoryScopeDecisionSchema = Type.Object(
  {
    source: Type.Union([Type.Literal('routing'), Type.Literal('allowed-repository-owners')]),
    decision: Type.Union([Type.Literal('local'), Type.Literal('swarm'), Type.Literal('deny')]),
    reason: Type.Union([
      Type.Literal('match'),
      Type.Literal('excluded'),
      Type.Literal('no-match'),
      Type.Literal('identity-mismatch'),
    ]),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    pattern: Type.Optional(repositoryPatternSchema),
  },
  { additionalProperties: false },
);
export type RepositoryScopeDecision = Static<typeof repositoryScopeDecisionSchema>;
type ScopePolicy = Pick<GitHubNotificationPolicy, 'routing' | 'allowedRepositoryOwners'>;
type Repository = { name: string; owner: { login: string; nodeId: string } };

function matches(pattern: string, path: string) {
  const expression = pattern.replace(/[.]/gu, '\\.').replace(/\*/gu, '[^/]*');
  return new RegExp(`^${expression}$`, 'iu').test(path);
}

/** evaluate canonical provider names, or legacy immutable pins, without provider access. */
export default function repositoryScope(
  policy: ScopePolicy,
  repository: Repository,
): RepositoryScopeDecision {
  if (policy.routing !== undefined) {
    const path = `${repository.owner.login}/${repository.name}`;
    for (const [index, route] of policy.routing.entries()) {
      const [pattern, target] =
        typeof route === 'string' ? [route, 'local' as const] : Object.entries(route)[0]!;
      const excluded = pattern.startsWith('!');
      if (matches(excluded ? pattern.slice(1) : pattern, path))
        return {
          source: 'routing',
          decision: excluded ? 'deny' : target,
          reason: excluded ? 'excluded' : 'match',
          index,
          pattern,
        };
    }
    return { source: 'routing', decision: 'deny', reason: 'no-match' };
  }
  const index = policy.allowedRepositoryOwners.findIndex((pin) =>
    githubIdentityMatches(pin, repository.owner),
  );
  return index < 0
    ? {
        source: 'allowed-repository-owners',
        decision: 'deny',
        reason: policy.allowedRepositoryOwners.some(
          (pin) => pin.login.toLowerCase() === repository.owner.login.toLowerCase(),
        )
          ? 'identity-mismatch'
          : 'no-match',
      }
    : { source: 'allowed-repository-owners', decision: 'local', reason: 'match', index };
}

/** offline checks cannot reject an unresolved id-only legacy owner. */
export function repositoryScopeCandidate(policy: ScopePolicy, owner: string, name: string) {
  return policy.routing !== undefined
    ? repositoryScope(policy, { name, owner: { login: owner, nodeId: '' } }).decision !== 'deny'
    : policy.allowedRepositoryOwners.some(
        (pin) => !pin.login || pin.login.toLowerCase() === owner.toLowerCase(),
      );
}
