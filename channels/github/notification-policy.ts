import resolvePullRequestRecipients from './pull-request-recipients.ts';
import type { GitHubNotificationsDeclaration } from './config-schema.ts';
import { feedbackIdentities } from './feedback-policy.ts';
import type { GitHubManifestConfiguration } from '../../manifest/github-schema.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';
import { defaultAssessmentSkill } from '../../manifest/assessment-schema.ts';

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
  const issue = declaration.issueAssignment;
  const review = declaration.reviewRequest;
  if (review?.enabled ?? Boolean(review?.allowed.length))
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/notifications/review-request',
      message: `${runtime === 'openclaw' ? 'OpenClaw' : 'Codex'} V2 does not support review requests. Issue assignment is independent.`,
      remediation:
        'Disable review requests or wait for its execution adapter; supported issue assignment can continue.',
      status: 'warning',
      workflow: 'review-request',
    });
  if (runtime !== 'openclaw' || !issue || !(issue.enabled ?? Boolean(issue.allowed.length)))
    return diagnostics;
  if (issue.mode !== 'plan')
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/notifications/issue-assignment/mode',
      message: `OpenClaw V2 does not support ${issue.mode} issue assignment.`,
      remediation:
        'Choose Plan mode explicitly to enable issue assignment; no mode is substituted automatically.',
      status: 'blocked',
      workflow: 'issue-assignment',
    });
  if (feedbackIdentities(issue.allowed, issue.feedback).length)
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/notifications/issue-assignment/feedback',
      message:
        'OpenClaw V2 does not support issue feedback. Assignment intake and planning can continue without processing comments.',
      remediation: 'Disable feedback to clear this warning or wait for its execution adapter.',
      status: 'warning',
      workflow: 'issue-assignment',
    });
  if (
    issue.assessment?.skill &&
    ![defaultAssessmentSkill, defaultAssessmentSkill.split(':').at(-1)!].includes(
      issue.assessment.skill,
    )
  )
    diagnostics.push({
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/github/notifications/issue-assignment/assessment/skill',
      message: 'OpenClaw V2 does not support replacement assessment skills.',
      remediation:
        'Choose the default assessment skill explicitly to enable issue assignment; no skill is substituted automatically.',
      status: 'blocked',
      workflow: 'issue-assignment',
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
