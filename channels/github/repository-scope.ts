import { Type, type Static } from 'typebox';

import { githubIdentityMatches } from './provider/work-item.ts';
import type { GitHubNotificationPolicy } from './workflow-policy.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';

// only segment-local stars are supported; do not interpret general glob syntax.
const patternBody = '(?!.*\\*\\*)[A-Za-z0-9*.-]+/[A-Za-z0-9*_.-]+(?![\\s\\S])';
export const repositoryPatternSchema = Type.String({ pattern: '^!?' + patternBody });
const positivePattern = Type.String({ pattern: '^' + patternBody });
const instanceIdSchema = Type.String({
  pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\\s\\S])',
});
const instancePoolSchema = Type.Array(instanceIdSchema, { minItems: 1, uniqueItems: true });
const workflows = ['issue-assignment', 'issue-pickup', 'review-request'] as const;
export type RoutingWorkflow = (typeof workflows)[number];
const workflowSchema = Type.Union([
  Type.Literal(workflows[0]),
  Type.Literal(workflows[1]),
  Type.Literal(workflows[2]),
  Type.Literal('project-pickup'),
]);
const ruleIdSchema = Type.String({ pattern: '^[^\\s\\x00-\\x1f\\x7f]+(?![\\s\\S])' });
const local = Type.Literal('local');
const swarm = Type.Literal('swarm');
const fullRouteSchema = Type.Object(
  {
    id: Type.Optional(ruleIdSchema),
    match: positivePattern,
    workflows: Type.Optional(Type.Array(workflowSchema, { minItems: 1, uniqueItems: true })),
    target: Type.Union([
      local,
      Type.Literal('deny'),
      swarm,
      Type.Object({ instance: instanceIdSchema }, { additionalProperties: false }),
      Type.Object({ instances: instancePoolSchema }, { additionalProperties: false }),
    ]),
  },
  { additionalProperties: false },
);
export const repositoryRouteSchema = Type.Union([
  repositoryPatternSchema,
  Type.Record(positivePattern, Type.Union([local, swarm, instanceIdSchema, instancePoolSchema]), {
    minProperties: 1,
    maxProperties: 1,
    additionalProperties: false,
  }),
  fullRouteSchema,
]);
export type RepositoryRoute = Static<typeof repositoryRouteSchema>;

function canonicalWorkflows(values: readonly (RoutingWorkflow | 'project-pickup')[]) {
  return [
    ...new Set(
      values.map((value) => (value === 'project-pickup' ? ('issue-pickup' as const) : value)),
    ),
  ];
}

/** accept the legacy input spelling without introducing a fourth workflow. */
export function decodeRepositoryRouting(routes: RepositoryRoute[]): RepositoryRoute[] {
  return routes.map((route) => {
    if (typeof route === 'string' || !Object.hasOwn(route, 'match')) return route;
    const full = route as Static<typeof fullRouteSchema>;
    return {
      ...full,
      ...(full.workflows ? { workflows: canonicalWorkflows(full.workflows) } : {}),
    };
  });
}

type Rule = {
  id?: string;
  match: string;
  workflows: readonly RoutingWorkflow[];
  target: 'local' | 'swarm' | 'deny' | string[];
};

function normalizeRule(route: RepositoryRoute): Rule {
  if (typeof route === 'string') {
    const excluded = route.startsWith('!');
    return {
      match: excluded ? route.slice(1) : route,
      workflows,
      target: excluded ? 'deny' : 'local',
    };
  }
  if (Object.hasOwn(route, 'match')) {
    const full = route as Static<typeof fullRouteSchema>;
    const target = full.target;
    return {
      id: full.id,
      match: full.match,
      workflows: full.workflows ? canonicalWorkflows(full.workflows).sort() : workflows,
      target:
        typeof target === 'string'
          ? target
          : 'instance' in target
            ? [target.instance]
            : [...target.instances].sort(),
    };
  }
  const [match, target] = Object.entries(route as Record<string, string | string[]>)[0]!;
  return {
    match,
    workflows,
    target:
      target === 'local' || target === 'swarm'
        ? target
        : Array.isArray(target)
          ? [...target].sort()
          : [target],
  };
}

/** preserve rule order while canonicalizing the unordered destination sets. */
export function normalizeRepositoryRouting(routes: RepositoryRoute[]) {
  return routes.map((entry) => {
    const { match: pattern, workflows: eligible, target } = normalizeRule(entry);
    const match = pattern.toLowerCase();
    // retain the persisted authority fingerprint while accepting either input spelling.
    if (eligible.length !== workflows.length)
      return {
        match,
        workflows: eligible
          .map((value) => (value === 'issue-pickup' ? 'project-pickup' : value))
          .sort(),
        target,
      };
    if (target === 'local') return match;
    if (target === 'deny') return '!' + match;
    return { [match]: target };
  });
}

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
    ruleId: Type.Optional(ruleIdSchema),
    pattern: Type.Optional(repositoryPatternSchema),
    eligibleInstanceIds: Type.Optional(instancePoolSchema),
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

/** warn only where an earlier rule provably covers each applicable workflow. */
export function repositoryRoutingDiagnostics(routes: RepositoryRoute[]): ManifestDiagnostic[] {
  const rules = routes.map(normalizeRule);
  const ids = new Set<string>();
  return rules.flatMap((rule, index): ManifestDiagnostic[] => {
    const fieldPath = '/github/routing/' + index;
    if (rule.id !== undefined && ids.has(rule.id))
      return [
        {
          code: 'github-routing-duplicate-rule-id',
          fieldPath: fieldPath + '/id',
          severity: 'error',
          message: `Routing rule ID "${rule.id}" is already used by an earlier rule.`,
        },
      ];
    if (rule.id !== undefined) ids.add(rule.id);
    const [owner, name] = rule.match.toLowerCase().split('/') as [string, string];
    const covers = (earlier: string, current: string) =>
      earlier === '*' ||
      earlier === current ||
      (!current.includes('*') && matches(earlier, current));
    const covering = rule.workflows.map((workflow) =>
      rules.findIndex((prior, i) => {
        if (i >= index || !prior.workflows.includes(workflow)) return false;
        const [priorOwner, priorName] = prior.match.toLowerCase().split('/') as [string, string];
        return covers(priorOwner, owner) && covers(priorName, name);
      }),
    );
    if (covering.some((i) => i < 0)) return [];
    const labels = [...new Set(covering)].map((i) => rules[i]!.id ?? `#${i + 1}`);
    return [
      {
        code: 'github-routing-rule-unreachable',
        fieldPath,
        severity: 'warning',
        message: `Routing rule ${rule.id ?? `#${index + 1}`} is shadowed by earlier rules: ${labels.join(', ')}.`,
      },
    ];
  });
}

/** evaluate canonical provider names, or legacy immutable pins, without provider access. */
export default function repositoryScope(
  policy: ScopePolicy,
  repository: Repository,
  workflow: RoutingWorkflow,
): RepositoryScopeDecision {
  if (policy.routing !== undefined) {
    const path = `${repository.owner.login}/${repository.name}`;
    for (const [index, route] of policy.routing.entries()) {
      const rule = normalizeRule(route);
      if (rule.workflows.includes(workflow) && matches(rule.match, path))
        return {
          source: 'routing',
          decision: Array.isArray(rule.target) ? 'swarm' : rule.target,
          reason: rule.target === 'deny' ? 'excluded' : 'match',
          index,
          pattern: rule.target === 'deny' ? '!' + rule.match : rule.match,
          ...(rule.id === undefined ? {} : { ruleId: rule.id }),
          ...(Array.isArray(rule.target) ? { eligibleInstanceIds: rule.target } : {}),
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
export function repositoryScopeCandidate(
  policy: ScopePolicy,
  owner: string,
  name: string,
  workflow: RoutingWorkflow,
) {
  return policy.routing !== undefined
    ? repositoryScope(policy, { name, owner: { login: owner, nodeId: '' } }, workflow).decision !==
        'deny'
    : policy.allowedRepositoryOwners.some(
        (pin) => !pin.login || pin.login.toLowerCase() === owner.toLowerCase(),
      );
}
