import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';
import { nativeObject } from '../../../agent/automation-gateway.ts';
import type { IntakeRecord } from '../intake/record-store.ts';

/** reconcile a retained PR identity before an idempotent close; never touch branch refs. */
export default async function closeResetPullRequest(
  account: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
  intake: IntakeRecord,
  receipt: { pullRequestNodeId: string; pullRequestNumber: number },
) {
  if (account.identity.nodeId !== intake.receiving.nodeId)
    throw new Error('notification-reset-account-changed');
  const path = `/repos/${encodeURIComponent(intake.repository.owner.login)}/${encodeURIComponent(intake.repository.name)}/pulls/${receipt.pullRequestNumber}`;
  const read = async () => {
    const response = await account.execute(['api', path]);
    if (response.exitCode !== 0 || response.timedOut || response.truncated)
      throw new Error('notification-reset-pr-unavailable');
    const pr: unknown = JSON.parse(response.stdout);
    if (
      !nativeObject(pr) ||
      pr.node_id !== receipt.pullRequestNodeId ||
      pr.number !== receipt.pullRequestNumber ||
      !nativeObject(pr.base) ||
      !nativeObject(pr.base.repo) ||
      pr.base.repo.node_id !== intake.repository.nodeId ||
      pr.base.repo.id !== intake.repository.databaseId ||
      !['open', 'closed'].includes(String(pr.state)) ||
      typeof pr.merged !== 'boolean'
    )
      throw new Error('notification-reset-pr-identity-changed');
    return pr;
  };
  const before = await read();
  if (before.merged || before.state === 'closed') return;
  const response = await account.execute(
    ['api', path, '--method', 'PATCH', '--input', '-'],
    JSON.stringify({ state: 'closed' }),
  );
  // always read after submission, including a lost or rejected response.
  const after = await read();
  if (after.merged || after.state === 'closed') return;
  throw new Error(
    response.exitCode === 0
      ? 'notification-reset-pr-close-unverified'
      : 'notification-reset-pr-close-failed',
  );
}
