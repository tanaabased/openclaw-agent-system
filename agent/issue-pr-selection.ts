import { automationHash } from './automation-hash.ts';
import type { AdoptedPullRequest } from './delivery-state.ts';
import IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import type { ManagedIssue } from './managed-issue.ts';
import type { ConnectedGitHubAccountClient } from '../core/github-account-client.ts';

export default async function verifyIssuePullRequest(
  intake: ManagedIssue,
  selected: AdoptedPullRequest,
  account: Pick<
    ConnectedGitHubAccountClient,
    'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
  >,
) {
  if (account.identity.nodeId !== intake.receiving.nodeId)
    throw new Error('delivery-adoption-account-changed');
  const observed = await new IssueDeliveryProvider(account).adopt(
    {
      repositoryNodeId: intake.repository.nodeId,
      item: {
        number: intake.issue.number,
        itemDatabaseId: intake.issue.databaseId,
        itemNodeId: intake.issue.nodeId,
        repositoryOwner: intake.repository.owner.login,
        repositoryName: intake.repository.name,
        repositoryDefaultBranch: selected.base,
      },
    },
    `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/pull/${selected.pullRequestNumber}`,
  );
  if (automationHash(observed) !== automationHash(selected))
    throw new Error('launch-pr-binding-changed');
}
