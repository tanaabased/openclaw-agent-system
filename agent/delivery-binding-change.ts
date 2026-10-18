const reasons = {
  repositoryId: 'repository',
  issueId: 'issue',
  sessionId: 'session',
  threadId: 'thread',
  worktree: 'worktree',
  branch: 'branch',
  base: 'base',
  authorId: 'account',
  policyDigest: 'policy',
} as const;

/** report the exact stable delivery field that changed, excluding per-attempt commit heads. */
export default function deliveryBindingChange(
  previous: object,
  current: object,
  fields: readonly (keyof typeof reasons)[],
) {
  const key = fields.find(
    (field) => previous[field as keyof typeof previous] !== current[field as keyof typeof current],
  );
  return key ? `delivery-${reasons[key]}-changed` : undefined;
}
