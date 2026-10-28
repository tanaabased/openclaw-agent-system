import { automationHash } from './automation-hash.ts';
import type { AdoptedPullRequest } from './delivery-state.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';

/** both adapters bind the same provider identity without implying publication success. */
export default async function bindIssuePullRequest(input: {
  id: string;
  digest?: string;
  operator: unknown;
  localBranch: string;
  head: string;
  previous?: {
    binding: { branch: string; base: string; authorId: string };
    localBranch?: string;
    pullRequest?: { pullRequestNodeId: string; pullRequestNumber: number };
    pendingPush?: unknown;
    creationAttempted: boolean;
    announcement?: DeliveryAnnouncementState;
  };
  adopted: AdoptedPullRequest;
  git(argv: string[]): Promise<string>;
  assertCurrent(): Promise<void>;
  verify(): Promise<AdoptedPullRequest>;
}) {
  const { id, adopted, previous, localBranch, head, git } = input;
  if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
  for (const branch of [localBranch, adopted.branch, adopted.base])
    await git(['check-ref-format', `refs/heads/${branch}`]);
  if (
    previous?.pullRequest?.pullRequestNodeId === adopted.pullRequestNodeId &&
    previous.pullRequest.pullRequestNumber === adopted.pullRequestNumber &&
    previous.binding.branch === adopted.branch &&
    previous.binding.base === adopted.base &&
    previous.binding.authorId === adopted.authorId &&
    (previous.localBranch ?? previous.binding.branch) === localBranch
  )
    return { status: 'bound' as const, retained: true, id, pullRequest: previous.pullRequest };
  if (
    previous?.pendingPush ||
    (previous?.creationAttempted && !previous.pullRequest) ||
    (previous?.announcement?.attempted && !previous.announcement.receipt)
  )
    throw new Error('delivery-binding-publication-pending');
  const digest = automationHash({
    id,
    operator: input.operator,
    adopted,
    localBranch,
    head,
    previous,
  });
  if (input.digest === undefined)
    return {
      status: 'binding-available' as const,
      id,
      digest,
      pullRequest: adopted,
      localBranch,
      instruction:
        'Apply this exact digest to select and fetch this PR. Preserve local work; binding records no publication or announcement.',
    };
  if (input.digest !== digest) throw new Error('delivery-binding-stale');
  const ref = `refs/agent-system/pr/${id}/${adopted.head}`;
  await git(['fetch', '--no-tags', 'origin', `refs/heads/${adopted.branch}:${ref}`]);
  if ((await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim() !== adopted.head)
    throw new Error('delivery-binding-stale');
  await git([
    'fetch',
    '--no-tags',
    'origin',
    `refs/heads/${adopted.base}:refs/remotes/origin/${adopted.base}`,
  ]);
  await input.assertCurrent();
  if (automationHash(await input.verify()) !== automationHash(adopted))
    throw new Error('delivery-binding-stale');
  return {
    status: 'bound' as const,
    id,
    fetchedRef: ref,
    pullRequest: adopted,
    instruction:
      'Selected and fetched the existing PR. Incorporate collaborator work before non-force delivery; no publication, attachment or announcement is recorded.',
  };
}
