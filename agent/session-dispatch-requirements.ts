import type { AgentManifest } from '../manifest/types.ts';

/** one catalog owns the consumers shown in consent, lifecycle, and tool access. */
export default function sessionDispatchRequirements(manifest: AgentManifest) {
  const policy = manifest.github?.notifications;
  if (policy?.schemaVersion !== 2 || !policy.runtimes.includes('openclaw')) return [];
  return [
    { id: 'github-issue-assignment', name: 'issue assignments', policy: policy.issueAssignment },
    { id: 'github-review-request', name: 'pull request reviews', policy: policy.reviewRequest },
  ]
    .filter(({ policy: trigger }) => !!trigger?.allowed.length)
    .map(({ id, name }) => ({ id, name }));
}

export const sessionDispatchScopes = ['operator.read', 'operator.write'] as const;

export function sessionDispatchDisclosure(consumers: readonly { name: string }[]) {
  return [
    'enable automatic work sessions for:',
    ...consumers.map(({ name }) => `- ${name}`),
    '',
    'enrollment included in this approval:',
    '- securely retain one shared gateway device credential',
    '- without it, automatic session dispatch is blocked',
    '',
    'grants (broader than sessions only):',
    ...sessionDispatchScopes.map((scope) => `- ${scope}`),
  ].join('\n');
}
