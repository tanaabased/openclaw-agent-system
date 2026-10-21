import resolvePullRequestRecipients from './pull-request-recipients.ts';
import type {
  ExternalGitHubNotifications,
  GitHubNotificationsDeclaration,
} from './config-schema.ts';
import { feedbackIdentities } from './feedback-policy.ts';
import type { GitHubManifestConfiguration } from '../../manifest/github-schema.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';

/** report compatibility at manifest entry points, never on each scheduled poll. */
export function githubPauseCompatibilityDiagnostics(
  declaration: ExternalGitHubNotifications | undefined,
): ManifestDiagnostic[] {
  return (['issue-assignment', 'review-request'] as const).flatMap((path) => {
    const workflow = declaration?.[path];
    if (workflow?.enabled === undefined) return [];
    const conflict = workflow.paused !== undefined && workflow.paused === workflow.enabled;
    return [
      {
        code: conflict
          ? 'github-notification-pause-conflict'
          : 'github-notification-enabled-deprecated',
        fieldPath: `/github/notifications/${path}/enabled`,
        severity: conflict ? ('error' as const) : ('warning' as const),
        message: conflict
          ? `enabled: ${workflow.enabled} conflicts with paused: ${workflow.paused}. Use paused: ${!workflow.enabled} or remove enabled.`
          : `enabled: ${workflow.enabled} is deprecated. Replace it with paused: ${!workflow.enabled}; pause controls future scheduled occurrences only.`,
      },
    ];
  });
}

/** preserve old author grants while explaining their explicit replacement. */
export function githubFeedbackCompatibilityDiagnostics(
  declaration: ExternalGitHubNotifications | undefined,
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  for (const path of ['issue-assignment', 'review-request'] as const) {
    const feedback = declaration?.[path]?.feedback;
    if (feedback === undefined || (typeof feedback === 'object' && feedback.inherit !== undefined))
      continue;
    diagnostics.push({
      code: 'github-notification-feedback-legacy',
      fieldPath: `/github/notifications/${path}/feedback`,
      severity: 'warning',
      message:
        feedback === true
          ? 'Boolean feedback is deprecated. Omit feedback to inherit approved parent actors, or use {inherit: true} with reply configuration.'
          : feedback === false
            ? 'Boolean feedback is deprecated. Preserve this opt-out with {inherit: false, allowed: []}; feedback belongs to its parent workflow.'
            : 'Feedback without explicit inherit retains its legacy replacement authors. Set inherit: false to preserve this list, or explicitly choose inherit: true to add parent actors.',
    });
  }
  return diagnostics;
}

/** validate portable policy without consulting providers, credentials, or installed state. */
export function validateGitHubNotificationPolicy(
  github: GitHubManifestConfiguration | undefined,
): ManifestDiagnostic[] {
  const policy = github?.notifications;
  if (policy?.schemaVersion !== 2) return [];
  const diagnostics: ManifestDiagnostic[] = [];
  if (typeof github?.username !== 'string' || !github.username.trim()) {
    diagnostics.push({
      code: 'github-notification-literal-username-required',
      fieldPath: '/github/username',
      message: 'Version 2 notifications require a literal GitHub username.',
      severity: 'error',
    });
  }
  const lists = [
    { path: 'allowed-repository-owners', identities: policy.allowedRepositoryOwners },
    { path: 'issue-assignment/allowed', identities: policy.issueAssignment?.allowed ?? [] },
    { path: 'review-request/allowed', identities: policy.reviewRequest?.allowed ?? [] },
  ];
  for (const { path, identities } of lists) {
    const nodes = new Set<string>();
    const logins = new Set<string>();
    identities.forEach(({ login, nodeId }, index) => {
      const normalizedLogin = login.toLowerCase();
      if (nodes.has(nodeId) || logins.has(normalizedLogin)) {
        diagnostics.push({
          code: 'github-notification-identity-duplicate',
          fieldPath: `/github/notifications/${path}/${index}`,
          message: 'Notification identities must have unique logins and node ids within each list.',
          severity: 'error',
        });
      }
      nodes.add(nodeId);
      logins.add(normalizedLogin);
    });
  }
  for (const [path, workflow] of [
    ['issue-assignment', policy.issueAssignment],
    ['review-request', policy.reviewRequest],
  ] as const) {
    try {
      feedbackIdentities(workflow?.allowed ?? [], workflow?.feedback);
    } catch {
      diagnostics.push({
        code: 'github-notification-feedback-identity-conflict',
        fieldPath: `/github/notifications/${path}/feedback`,
        message:
          'Feedback identity pins conflict. Use one login and immutable node id for each identity.',
        severity: 'error',
      });
    }
  }
  try {
    resolvePullRequestRecipients(
      policy.issueAssignment?.pullRequest?.recipients?.filter((entry) => !('source' in entry)) ??
        [],
    );
  } catch {
    diagnostics.push({
      code: 'github-notification-recipient-invalid',
      fieldPath: '/github/notifications/issue-assignment/pull-request/recipients',
      message: 'Recipient pins conflict or exceed the assignee limit.',
      severity: 'error',
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
  if (declaration?.schemaVersion !== 2 || !declaration.runtimes.includes(runtime)) return [];
  const diagnostics: GitHubNotificationRuntimeDiagnostic[] = [];
  const review = declaration.reviewRequest;
  if (
    review &&
    (review.paused !== undefined || review.enabled !== undefined || review.allowed.length)
  )
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/notifications/review-request',
      message: `${runtime === 'openclaw' ? 'OpenClaw' : 'Codex'} V2 does not support review requests. Issue assignment is independent.`,
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
