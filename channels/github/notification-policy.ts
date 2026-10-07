import type { GitHubNotificationsDeclaration } from './config-schema.ts';
import type { GitHubManifestConfiguration } from '../../manifest/github-schema.ts';
import type { ManifestDiagnostic } from '../../manifest/types.ts';

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
    { path: 'feedback/allowed', identities: policy.feedback?.allowed ?? [] },
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
  return diagnostics;
}

/** schema support is not runtime support; no version 2 execution adapter ships yet. */
export function githubNotificationRuntimeBlocker(
  declaration: GitHubNotificationsDeclaration | undefined,
  runtime: 'openclaw' | 'codex',
) {
  if (declaration?.schemaVersion !== 2 || !declaration.runtimes.includes(runtime)) return;
  return {
    code: 'github-notification-runtime-unsupported',
    message: `Version 2 GitHub notifications are declared for ${runtime}, but its execution adapter is not implemented.`,
    remediation:
      'Keep this as inactive profile preparation until the notification runtime is available; no monitoring was activated.',
    status: 'blocked' as const,
  };
}
