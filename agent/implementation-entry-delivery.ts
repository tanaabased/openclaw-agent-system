import { realpath } from 'node:fs/promises';
import type { Static } from 'typebox';

import IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import { gitRemoteIdentity } from '../tools/git/worktree-remote.ts';
import type { directImplementationRequestSchema } from '../tools/dispatch/implementation-schema.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import { automationHash } from './automation-hash.ts';
import deliveryBindingChange from './delivery-binding-change.ts';
import type { ImplementationEntry } from './implementation-entry-state.ts';
import publishIssueDelivery from './publish-issue-delivery.ts';
import { replyLocator } from './reply-target.ts';

/** reuse the publication owner and receipts without synthesizing an intake assignment. */
export default async function implementationEntryDelivery(input: {
  entry: ImplementationEntry;
  action: Static<typeof directImplementationRequestSchema>;
  deps: AssessmentEntryDependencies;
  save(): Promise<void>;
  provider?: Pick<IssueDeliveryProvider, 'inspect' | 'publish'>;
}) {
  const { entry, action, deps, save } = input;
  const locator = replyLocator(entry.target);
  const repository = `${locator.owner}/${locator.name}`;
  const authorize = async () => {
    await deps.assertCurrent();
    if (entry.scope !== 'pull-request' || entry.result?.outcome !== 'done')
      throw new Error('implementation-publication-not-authorized');
    if (await deps.managed({ repository, number: locator.number }))
      throw new Error('implementation-managed-context-changed');
  };
  await authorize();
  const operation = action.deliveryOperation;
  if (!operation) throw new Error('implementation-delivery-operation-required');
  if (operation === 'present') {
    if (!entry.delivery?.pullRequest || !entry.delivery.reconciled)
      throw new Error('delivery-reconciliation-required');
    const url = `https://github.com/${repository}/pull/${entry.delivery.pullRequest.pullRequestNumber}`;
    return {
      status: 'delivered',
      id: entry.id,
      url,
      presentation: url,
      handoff: { next: 'complete' },
    };
  }
  if (!deps.connectDelivery) throw new Error('implementation-delivery-unavailable');
  const connection = await deps.connectDelivery(entry.checkout.path);
  const provider = input.provider ?? new IssueDeliveryProvider(connection.account);
  const client = await deps.connectProvider();
  const repo = await client.getRepository(locator.owner, locator.name);
  const issue = await client.getItem(locator.owner, locator.name, locator.number);
  if (
    repo.nodeId !== entry.repositoryId ||
    issue.nodeId !== entry.subjectId ||
    issue.itemType !== 'issue'
  )
    throw new Error('implementation-target-identity-mismatch');
  const git = async (argv: string[]) => {
    await authorize();
    return (await connection.git(argv)).trim();
  };
  if ((await realpath(await git(['rev-parse', '--show-toplevel']))) !== entry.checkout.path)
    throw new Error('delivery-worktree-diverged');
  const branch = await git(['branch', '--show-current']);
  if (!branch || branch === repo.defaultBranch) throw new Error('delivery-branch-required');
  await git(['check-ref-format', `refs/heads/${branch}`]);
  if (operation !== 'reconcile' && (await git(['status', '--porcelain=v1'])))
    throw new Error('delivery-uncommitted-work');
  const head =
    operation === 'reconcile' && entry.delivery
      ? entry.delivery.binding.head
      : await git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
  const count = Number(
    await git(['rev-list', '--count', `refs/remotes/origin/${repo.defaultBranch}..${head}`]),
  );
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('delivery-committed-work-required');
  const remotes = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/u);
  if (
    !remotes.length ||
    remotes.some((remote) => gitRemoteIdentity(remote) !== `github.com/${repository.toLowerCase()}`)
  )
    throw new Error('delivery-push-destination-mismatch');
  const binding = {
    repositoryId: entry.repositoryId,
    issueId: entry.subjectId,
    sessionId: deps.binding.incarnation,
    threadId: deps.binding.session,
    worktree: entry.checkout.path,
    branch,
    base: repo.defaultBranch,
    head,
    authorId: connection.account.identity.nodeId,
    policyDigest: automationHash(entry.authorization),
  };
  const previous = entry.delivery;
  const changed =
    previous &&
    deliveryBindingChange(previous.binding, binding, [
      'repositoryId',
      'issueId',
      'sessionId',
      'threadId',
      'worktree',
      'branch',
      'base',
      'authorId',
    ]);
  if (changed) throw new Error(changed);
  const title = action.title ?? previous?.title,
    body = action.body ?? previous?.body;
  if (!title?.trim() || !body?.trim() || title.includes('\0') || body.includes('\0'))
    throw new Error('delivery-authored-content-required');
  if (
    previous &&
    (title !== previous.title || body !== previous.body || head !== previous.binding.head)
  )
    throw new Error('delivery-content-changed');
  const delivery = (entry.delivery ??= {
    id: automationHash({ binding, title, body }),
    binding,
    title,
    body,
    creationAttempted: false,
    reconciled: false,
  });
  await save();
  if (operation === 'prepare')
    return { status: 'prepared', id: entry.id, digest: delivery.id, title, body, branch, head };
  if (operation === 'publish' && action.digest !== delivery.id)
    throw new Error('delivery-digest-stale');
  await publishIssueDelivery({
    delivery,
    publication: {
      item: {
        number: issue.number,
        itemDatabaseId: issue.databaseId,
        itemNodeId: issue.nodeId,
        repositoryOwner: repo.owner.login,
        repositoryName: repo.name,
        repositoryDefaultBranch: repo.defaultBranch,
      },
      repositoryNodeId: repo.nodeId,
      branch,
      title,
      body,
      headSha: head,
      linkIssue: true,
    },
    provider,
    git:
      operation === 'reconcile'
        ? async (argv) => {
            if (argv[0] === 'push') throw new Error('delivery-publication-required');
            return git(argv);
          }
        : git,
    authorize,
    beforeCreate: async () => {
      if (operation === 'reconcile') throw new Error('delivery-publication-required');
    },
    save,
  });
  const url = `https://github.com/${repository}/pull/${delivery.pullRequest!.pullRequestNumber}`;
  return {
    status: 'delivered',
    id: entry.id,
    url,
    presentation: url,
    handoff: { next: 'complete' },
  };
}
