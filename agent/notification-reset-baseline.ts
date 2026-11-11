import { IntakeError, type IntakeState } from '../channels/github/intake/record-store.ts';

/** Preview an empty baseline without scanning assignments or activating either workflow. */
export default async function notificationResetBaseline(input: {
  scope: string;
  workspace: string;
  agentId: string;
  policy: { username: string; digest: string } | undefined;
  identity(): Promise<{ login: string; nodeId: string }>;
}): Promise<IntakeState> {
  if (!input.policy) throw new IntakeError('intake-policy-disabled');
  const identity = await input.identity();
  if (identity.login.toLowerCase() !== input.policy.username.toLowerCase())
    throw new IntakeError('intake-github-identity-mismatch');
  return {
    version: 1,
    scope: input.scope,
    workspaceDir: input.workspace,
    agentId: input.agentId,
    account: { login: identity.login, nodeId: identity.nodeId },
    policyDigest: input.policy.digest,
    // Keep preview fingerprints stable; confirmed reset supplies the current-time cutoff.
    baselineAt: 0,
    records: [],
  };
}
