import { githubIdentitySet } from './provider/work-item.ts';
import { issuePickupConfigurationCode } from './issue-pickup-schema.ts';
import { repositoryRoutingDiagnostics, repositoryScopeCandidate } from './repository-scope.ts';
import type { GitHubNotificationsDeclaration } from './workflow-policy.ts';
import type { GitHubManifestConfiguration } from '../../manifest/github-schema.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';

/** validate portable policy without consulting providers, credentials, or installed state. */
export function validateGitHubNotificationPolicy(
  github: GitHubManifestConfiguration | undefined,
  legacyOwnersDeclared = github?.notifications?.routing === undefined,
): ManifestDiagnostic[] {
  const policy = github?.notifications;
  if (!policy) return [];
  const diagnostics = policy.routing ? repositoryRoutingDiagnostics(policy.routing) : [];
  if (legacyOwnersDeclared)
    diagnostics.push({
      code:
        policy.routing === undefined
          ? 'github-repository-owners-deprecated'
          : 'github-repository-owners-ignored',
      fieldPath: '/github/allowed-repository-owners',
      severity: 'warning',
      message:
        policy.routing === undefined
          ? 'allowed-repository-owners is deprecated. Use ordered github.routing name patterns for new work; legacy identity pins remain active until you migrate.'
          : 'github.routing takes precedence. allowed-repository-owners is ignored; remove the deprecated property after migration to avoid restoring it when routing is removed.',
    });
  if (policy.issuePickup) {
    if (!policy.issueAssignment)
      diagnostics.push({
        code: 'github-issue-pickup-assignment-required',
        fieldPath: '/github/issue-pickup',
        message:
          'Issue pickup requires issue-assignment and its existing actor and workflow settings.',
        severity: 'error',
      });
    if (!policy.issuePickup.schedule)
      diagnostics.push({
        code: 'github-issue-pickup-schedule-invalid',
        fieldPath: '/github/issue-pickup',
        message:
          policy.issuePickup.timingError === 'issue-pickup-timing-conflict'
            ? 'window, duration and end must describe the same pickup period.'
            : 'Use a local start time, a positive window of at most 24 hours, and scans spaced at least one minute apart.',
        severity: 'error',
      });
    const repositories = new Set<string>();
    for (const [index, project] of policy.issuePickup.projects.entries()) {
      const repository = project.repository.toLowerCase();
      const [owner, name] = repository.split('/') as [string, string];
      const fieldPath = `/github/issue-pickup/projects/${index}/repository`;
      if (repositories.has(repository))
        diagnostics.push({
          code: 'github-issue-pickup-repository-duplicate',
          fieldPath,
          message: 'Configure each pickup repository only once.',
          severity: 'error',
        });
      repositories.add(repository);
      if (!repositoryScopeCandidate(policy, owner, name, 'issue-pickup'))
        diagnostics.push({
          code: 'github-issue-pickup-repository-outside-workflow',
          fieldPath,
          message:
            'Choose a repository included by github.routing, or by legacy owners when routing is absent. Pickup does not expand repository access.',
          severity: 'error',
        });
    }
  }
  if (typeof github?.username !== 'string' || !github.username.trim()) {
    diagnostics.push({
      code: 'github-notification-literal-username-required',
      fieldPath: '/github/username',
      message: 'GitHub workflows require a literal GitHub username.',
      severity: 'error',
    });
  }
  const lists = [
    {
      path: 'allowed-repository-owners',
      identities: policy.routing === undefined ? policy.allowedRepositoryOwners : [],
    },
    { path: 'issue-assignment/allowed', identities: policy.issueAssignment?.allowed ?? [] },
    { path: 'review-request/allowed', identities: policy.reviewRequest?.allowed ?? [] },
  ];
  const reviewers =
    policy.issueAssignment?.pullRequest?.recipients?.flatMap((entry) =>
      'source' in entry ? [] : [entry],
    ) ?? [];
  try {
    githubIdentitySet(
      [...lists.flatMap(({ identities }) => identities), ...reviewers].filter(
        (entry) => !entry.reference,
      ),
    );
  } catch {
    diagnostics.push({
      code: 'github-identity-conflict',
      fieldPath: '/github',
      severity: 'error',
      message:
        'Use one immutable node id for each GitHub identity; name aliases do not grant additional authority.',
    });
  }

  return diagnostics;
}

export interface GitHubNotificationRuntimeDiagnostic {
  code:
    | 'github-notification-runtime-unsupported'
    | 'issue-pickup-schedule-unsupported'
    | 'issue-pickup-timing-conflict'
    | 'issue-pickup-schedule-precision';
  fieldPath: string;
  message: string;
  remediation: string;
  status: 'blocked' | 'warning';
  workflow: 'issue-assignment' | 'review-request' | 'issue-pickup';
}

/** scope missing capabilities to their workflow; optional feedback never gates assignment. */
export function githubNotificationRuntimeDiagnostics(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
): GitHubNotificationRuntimeDiagnostic[] {
  if (!declaration || !declaration.runtimes.includes(runtime)) return [];
  const diagnostics: GitHubNotificationRuntimeDiagnostic[] = [];
  const pickupCode = issuePickupConfigurationCode(declaration);
  if (pickupCode)
    diagnostics.push({
      code: pickupCode,
      fieldPath: '/github/issue-pickup',
      message: 'Issue pickup timing is invalid or conflicting.',
      remediation:
        'Set start, window (or duration/end), and scans. Use matching duration fields and at least one minute between scans; the daily window cannot exceed 24 hours.',
      status: 'warning',
      workflow: 'issue-pickup',
    });
  const review = declaration.reviewRequest;
  if (review && (review.paused !== undefined || review.allowed.length))
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/review-request',
      message: `${runtime === 'openclaw' ? 'OpenClaw' : 'Codex'} does not support review requests. Issue assignment is independent.`,
      remediation:
        'Remove the review-request declaration or wait for its execution adapter; supported issue assignment can continue.',
      status: 'warning',
      workflow: 'review-request',
    });
  return diagnostics;
}

/** only required assignment capabilities may prevent its intake and scheduling. */
export function githubNotificationRuntimeBlocker(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
) {
  return githubNotificationRuntimeDiagnostics(declaration, runtime).find(
    ({ status, workflow }) => status === 'blocked' && workflow === 'issue-assignment',
  );
}
