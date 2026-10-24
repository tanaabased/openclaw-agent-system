import type { AgentManifest } from '../manifest/types.ts';

/** one catalog owns the consumers shown in consent, lifecycle, and tool access. */
export default function sessionDispatchRequirements(
  manifest: AgentManifest,
  manualSessionDispatch = false,
) {
  const policy = manifest.github?.notifications;
  const automatic = policy?.runtimes.includes('openclaw') ? policy.issueAssignment : undefined;
  return [{ id: 'github-issue-assignment', name: 'issue assignments', policy: automatic }]
    .filter(({ policy: trigger }) => Boolean(trigger))
    .map(({ id, name }) => ({ id, name }))
    .concat(
      manualSessionDispatch ? [{ id: 'github-issue-launch', name: 'manual issue launch' }] : [],
    );
}

export const sessionDispatchScopes = ['operator.read', 'operator.write'] as const;

export function sessionDispatchDisclosure(consumers: readonly { name: string }[]) {
  return [
    'enable work sessions for:',
    ...consumers.map(({ name }) => `- ${name}`),
    '',
    'enrollment included in this approval:',
    '- securely retain one shared gateway device credential',
    '- without it, managed session dispatch is blocked',
    '',
    'grants (broader than sessions only):',
    ...sessionDispatchScopes.map((scope) => `- ${scope}`),
  ].join('\n');
}
