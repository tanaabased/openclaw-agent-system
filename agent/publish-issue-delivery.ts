import type IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import type { IssueDeliveryInput } from '../channels/github/publication/issue-delivery.ts';
import { gitRemoteIdentity } from '../tools/git/worktree-remote.ts';

interface DeliveryState {
  creationAttempted: boolean;
  pushedHead?: string;
  pendingPush?: { previousHead: string; head: string };
  pullRequest?: IssueDeliveryInput['expectedPullRequest'];
  contentUpdate?: IssueDeliveryInput['contentUpdate'];
  reconciled: boolean;
}

/** both native hosts resume the same publication, preserving receipts after partial failure. */
export default async function publishIssueDelivery(input: {
  delivery: DeliveryState;
  publication: IssueDeliveryInput & { headSha: string };
  provider: Pick<IssueDeliveryProvider, 'inspect' | 'publish'>;
  git(argv: string[]): Promise<string>;
  push?(head: string, ref: string, remotes: string[]): Promise<void>;
  authorize(): Promise<void>;
  beforeCreate?(): Promise<void>;
  save(): Promise<void>;
}) {
  const { delivery, publication, provider, git, authorize, save } = input;
  await authorize();
  delivery.reconciled = false;
  await save();
  const ref = `refs/heads/${publication.branch}`;
  const head = publication.headSha;
  const remoteHead =
    (await git(['ls-remote', '--heads', 'origin', ref])).trim().split(/\s/u)[0] ?? '';
  if (publication.adoptedPullRequest && !remoteHead)
    throw new Error('delivery-source-branch-missing');
  if (remoteHead && remoteHead !== head) {
    if (!delivery.pullRequest) throw new Error('delivery-remote-head-diverged');
    await git(['merge-base', '--is-ancestor', remoteHead, head]);
  }
  const operation: IssueDeliveryInput = {
    ...publication,
    expectedPullRequest: delivery.pullRequest,
    contentUpdate: delivery.contentUpdate,
    async beforeCreate() {
      await authorize();
      await input.beforeCreate?.();
      if (delivery.creationAttempted) throw new Error('delivery-creation-uncertain');
      delivery.creationAttempted = true;
      await save();
    },
    async onCreateRejected() {
      delivery.creationAttempted = false;
      await save();
    },
    async checkpoint(receipt) {
      delivery.pullRequest = receipt;
      await save();
    },
  };
  // a prior verified push may still be absent from the provider's PR readback.
  operation.expectedPullRequest = await provider.inspect({
    ...operation,
    headSha: remoteHead,
    previousHeadSha:
      delivery.pendingPush?.head === remoteHead ? delivery.pendingPush.previousHead : undefined,
  });
  const remotes = (await git(['remote', 'get-url', '--push', '--all', 'origin']))
    .trim()
    .split(/\r?\n/u);
  const repository = `${publication.item.repositoryOwner}/${publication.item.repositoryName}`;
  let destinations: string[];
  try {
    destinations = remotes.map(gitRemoteIdentity);
  } catch {
    throw new Error('delivery-push-destination-mismatch');
  }
  if (destinations.some((remote) => remote !== `github.com/${repository.toLowerCase()}`))
    throw new Error('delivery-push-destination-mismatch');
  if (remoteHead !== head) {
    await authorize();
    if (remoteHead) delivery.pendingPush = { previousHead: remoteHead, head };
    else delete delivery.pendingPush;
    await save();
    if (input.push) await input.push(head, ref, remotes);
    else await git(['push', '--set-upstream', 'origin', `${head}:${ref}`]);
  }
  if ((await git(['ls-remote', '--heads', 'origin', ref])).trim().split(/\s/u)[0] !== head)
    throw new Error('delivery-push-unverified');
  delivery.pushedHead = head;
  await save();
  await authorize();
  if (delivery.pendingPush?.head === head)
    operation.previousHeadSha = delivery.pendingPush.previousHead;
  await provider.publish(operation);
  delete delivery.pendingPush;
  delete delivery.contentUpdate;
  delivery.reconciled = true;
  await save();
}
