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

/** report unsupported enabled workflows; lifecycle owners inspect runtime readiness separately. */
export function githubNotificationRuntimeBlocker(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
) {
  if (declaration?.schemaVersion !== 2 || !declaration.runtimes.includes(runtime)) return;
  const triggers = [declaration.issueAssignment, declaration.reviewRequest];
  if (
    triggers.some((trigger) => trigger?.enabled === false) &&
    triggers.every((trigger) => !trigger || trigger.enabled === false)
  )
    return;
  if (runtime === 'openclaw') {
    const issue = declaration.issueAssignment;
    const review = declaration.reviewRequest;
    const issueEnabled = issue && (issue.enabled ?? Boolean(issue.allowed.length));
    let capability: string | undefined;
    if (review?.enabled ?? Boolean(review?.allowed.length)) capability = 'review requests';
    else if (issueEnabled && issue.mode !== 'plan') capability = `${issue.mode} issue assignment`;
    else if (issueEnabled && feedbackIdentities(issue.allowed, issue.feedback).length)
      capability = 'issue feedback';
    else if (
      issueEnabled &&
      issue.assessment?.skill &&
      ![defaultAssessmentSkill, defaultAssessmentSkill.split(':').at(-1)!].includes(
        issue.assessment.skill,
      )
    )
      capability = 'replacement assessment skills';
    if (!capability) return;
    return {
      code: 'github-notification-runtime-unsupported',
      message: `OpenClaw V2 does not support ${capability}.`,
      remediation:
        'Use Plan-mode issue assignment with the default assessment skill and feedback disabled; disable review requests. Enrollment, intake and automation readiness are checked separately.',
      status: 'blocked' as const,
    };
  }
  if (
    runtime === 'codex' &&
    !(declaration.reviewRequest?.enabled ?? Boolean(declaration.reviewRequest?.allowed.length))
  )
    return;
  return {
    code: 'github-notification-runtime-unsupported',
    message: `Version 2 GitHub notifications are declared for ${runtime}, but its execution adapter is not implemented.`,
    remediation:
      'Keep this as inactive profile preparation until the notification runtime is available; no monitoring was activated.',
    status: 'blocked' as const,
  };
}
