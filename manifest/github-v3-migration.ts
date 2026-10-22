import { stringify } from 'yaml';

import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import type { GitHubIdentityPin } from '../channels/github/workflow-policy.ts';
import type { AgentManifestLoadResult } from './load.ts';
import type { AssessmentConfiguration } from './assessment-schema.ts';

const identity = ({ login, nodeId }: GitHubIdentityPin) => ({ login, 'node-id': nodeId });
const customization = (value: AssessmentConfiguration | boolean | undefined) =>
  typeof value === 'object'
    ? {
        ...(value.skill ? { skill: value.skill } : {}),
        ...(value.guidance ? { guidance: value.guidance } : {}),
      }
    : {};

/** Preview the composed policy without rewriting sources, resolving secrets or changing authority. */
export default function githubV3Migration(
  loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>,
) {
  const policy = loaded.manifest.github?.notifications;
  const sources = [loaded.path, ...(loaded.overlayPath ? [loaded.overlayPath] : [])];
  if (!policy || policy.schemaVersion === 3)
    return {
      status: policy ? ('already-v3' as const) : ('not-configured' as const),
      sources,
      resolutions: [],
      yaml: undefined,
    };
  const resolutions: Array<{ code: string; fieldPath: string; message: string }> = [];
  const issue = policy.issueAssignment;
  const recipients = issue?.pullRequest?.recipients;
  const reviewers =
    recipients?.flatMap((entry) =>
      !('source' in entry) && entry.roles.includes('reviewer') ? [entry] : [],
    ) ?? [];
  if (
    recipients &&
    (!recipients.some((entry) => 'source' in entry && entry.roles.includes('assignee')) ||
      recipients.some((entry) =>
        'source' in entry ? entry.roles.includes('reviewer') : entry.roles.includes('assignee'),
      ))
  )
    resolutions.push({
      code: 'github-v3-recipient-resolution',
      fieldPath: '/github/notifications/issue-assignment/pull-request',
      message:
        'V3 always assigns the original assignment actor. Resolve the existing assignee override or dynamic reviewer before replacing the policy.',
    });
  for (const [name, workflow, extra] of [
    ['issue-assignment', issue, reviewers],
    ['review-request', policy.reviewRequest, []],
  ] as const) {
    if (!workflow) continue;
    const previous = feedbackIdentities(workflow.allowed, workflow.feedback);
    const proposed = feedbackIdentities(workflow.allowed, { inherit: true, allowed: [...extra] });
    const ids = (pins: GitHubIdentityPin[]) =>
      [...new Set(pins.map(({ nodeId }) => nodeId))].sort().join('\0');
    if (ids(previous) !== ids(proposed))
      resolutions.push({
        code: 'github-v3-feedback-resolution',
        fieldPath: `/github/notifications/${name}/feedback`,
        message:
          'V3 derives feedback authors from allowed actors and reviewers. Explicitly resolve additions or removals before adoption; there is no independent feedback-off switch.',
      });
  }
  if (loaded.manifest.cleanupMigration)
    resolutions.push({
      code: 'github-v3-cleanup-resolution',
      fieldPath: '/github/notifications/cleanup',
      message:
        'Choose installation-owned cleanup policy and remove every legacy cleanup declaration from base and overlay before adopting this draft.',
    });
  const github = {
    'schema-version': 3,
    runtimes: policy.runtimes,
    'interval-minutes': policy.intervalMinutes,
    'max-concurrent-items': policy.maxConcurrentItems,
    'allowed-repository-owners': policy.allowedRepositoryOwners.map(identity),
    ...(issue
      ? {
          'issue-assignment': {
            paused: issue.paused ?? issue.enabled === false,
            allowed: issue.allowed.map(identity),
            mode: issue.mode,
            reviewers: reviewers.map(identity),
            assessment: customization(issue.assessment),
            implementation: customization(issue.implementation),
            feedback: customization(issue.feedback),
          },
        }
      : {}),
    ...(policy.reviewRequest
      ? {
          'review-request': {
            paused: policy.reviewRequest.paused ?? policy.reviewRequest.enabled === false,
            allowed: policy.reviewRequest.allowed.map(identity),
            review: customization(policy.reviewRequest.review),
            feedback: customization(policy.reviewRequest.feedback),
          },
        }
      : {}),
  };
  return {
    status: resolutions.length ? ('requires-resolution' as const) : ('ready' as const),
    sources,
    resolutions,
    yaml: stringify({ github }),
  };
}
