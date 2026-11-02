import { githubIdentitySet } from './provider/work-item.ts';
import { projectPickupConfigurationCode } from './project-pickup-schema.ts';
import { repositoryScopeCandidate } from './repository-scope.ts';
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
  const diagnostics: ManifestDiagnostic[] = [];
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
  if (policy.projectPickup) {
    if (!policy.issueAssignment)
      diagnostics.push({
        code: 'github-project-pickup-assignment-required',
        fieldPath: '/github/project-pickup',
        message:
          'Project pickup requires issue-assignment and its existing actor and workflow settings.',
        severity: 'error',
      });
    if (!policy.projectPickup.schedule)
      diagnostics.push({
        code: 'github-project-pickup-schedule-invalid',
        fieldPath: '/github/project-pickup/schedule',
        message:
          'Use a recurring automation schedule (cron with an optional IANA timezone, or every). One-shot schedules are not supported.',
        severity: 'error',
      });
    const [owner, name] = policy.projectPickup.projects[0]!.repository.split('/');
    if (!repositoryScopeCandidate(policy, owner!, name!))
      diagnostics.push({
        code: 'github-project-pickup-repository-outside-workflow',
        fieldPath: '/github/project-pickup/projects/0/repository',
        message:
          'Choose a repository included by github.routing, or by legacy owners when routing is absent. Pickup does not expand repository access.',
        severity: 'error',
      });
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
    | 'project-pickup-coordinator-required'
    | 'project-pickup-coordinator-mismatch'
    | 'project-pickup-schedule-unsupported';
  fieldPath: string;
  message: string;
  remediation: string;
  status: 'blocked' | 'warning';
  workflow: 'issue-assignment' | 'review-request' | 'project-pickup';
}

/** scope missing capabilities to their workflow; optional feedback never gates assignment. */
export function githubNotificationRuntimeDiagnostics(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
): GitHubNotificationRuntimeDiagnostic[] {
  if (!declaration || !declaration.runtimes.includes(runtime)) return [];
  const diagnostics: GitHubNotificationRuntimeDiagnostic[] = [];
  const pickupCode = projectPickupConfigurationCode(declaration, runtime);
  if (pickupCode)
    diagnostics.push({
      code: pickupCode,
      fieldPath: '/github/project-pickup',
      message:
        'Project pickup requires its designated runtime and installation, with intake cadence no longer than the pickup window.',
      remediation:
        'Set project-pickup.coordinator to the intended runtime and existing installation ID, and choose a supported cadence within window-minutes. Run Install only on the designated installation; ordinary assignments remain independent.',
      status: 'warning',
      workflow: 'project-pickup',
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
