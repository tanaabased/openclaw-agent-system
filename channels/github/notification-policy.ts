import { githubIdentitySet } from './provider/work-item.ts';
import type { GitHubNotificationsDeclaration } from './workflow-policy.ts';
import type { GitHubManifestConfiguration } from '../../manifest/github-schema.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';

/** validate portable policy without consulting providers, credentials, or installed state. */
export function validateGitHubNotificationPolicy(
  github: GitHubManifestConfiguration | undefined,
): ManifestDiagnostic[] {
  const policy = github?.notifications;
  if (!policy) return [];
  const diagnostics: ManifestDiagnostic[] = [];
  if (typeof github?.username !== 'string' || !github.username.trim()) {
    diagnostics.push({
      code: 'github-notification-literal-username-required',
      fieldPath: '/github/username',
      message: 'GitHub workflows require a literal GitHub username.',
      severity: 'error',
    });
  }
  const lists = [
    { path: 'allowed-repository-owners', identities: policy.allowedRepositoryOwners },
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
  code: 'github-notification-runtime-unsupported';
  fieldPath: string;
  message: string;
  remediation: string;
  status: 'blocked' | 'warning';
  workflow: 'issue-assignment' | 'review-request';
}

/** scope missing capabilities to their workflow; optional feedback never gates assignment. */
export function githubNotificationRuntimeDiagnostics(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
): GitHubNotificationRuntimeDiagnostic[] {
  if (!declaration || !declaration.runtimes.includes(runtime)) return [];
  const diagnostics: GitHubNotificationRuntimeDiagnostic[] = [];
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
