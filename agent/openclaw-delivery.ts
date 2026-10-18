import deliveryBindingChange from './delivery-binding-change.ts';
import deliveryAnnouncement, { announcementPresentation } from './delivery-announcement.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import GitHubIssueCommentClient from '../channels/github/provider/issue-comment-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import { realpath } from 'node:fs/promises';

import { automationHash } from './automation-hash.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { OpenClawWorkAction } from './openclaw-work.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../channels/github/publication/issue-delivery.ts';
import resolvePullRequestRecipients from '../channels/github/pull-request-recipients.ts';
import { githubNotificationPullRequestOpenedCard } from '../channels/github/presentation/pull-request-opened.ts';
import type { GitHubPullRequestRecipient } from '../channels/github/config-schema.ts';
import type { ConnectedGitHubAccountClient } from '../core/github-account-client.ts';
import { gitRemoteIdentity } from '../tools/git/worktree-remote.ts';

export interface OpenClawDeliveryConnection {
  account: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>;
  git(argv: string[]): Promise<string>;
}

/** the native owner retains authority and recovery; the provider owns GitHub publication. */
export default async function openClawDelivery(input: {
  record: OpenClawDispatchRecord;
  intake: IntakeRecord;
  action: Extract<OpenClawWorkAction, { action: 'delivery' }>;
  source: { runId: string; inputEventId: string };
  base: string;
  recipients?: GitHubPullRequestRecipient[];
  feedbackEnabled: boolean;
  selectAnnouncement?(
    state?: DeliveryAnnouncementState,
  ): Promise<DeliveryAnnouncementState['composition']>;
  connect(): Promise<OpenClawDeliveryConnection>;
  assertCurrent(): Promise<void>;
  reauthorize(): Promise<void>;
  save(): Promise<void>;
  signal: AbortSignal;
}) {
  const { record, intake, action, assertCurrent, save } = input;
  const work = record.work;
  if (!record.handoff || !work?.publication) throw new Error('delivery-human-publication-required');
  if (
    work.result?.outcome === 'blocked' ||
    (work.implementation && work.result?.outcome !== 'done')
  )
    throw new Error('delivery-implementation-incomplete');
  if (work.assessmentDigest !== automationHash(record.result))
    throw new Error('dispatch-work-assessment-changed');
  await assertCurrent();
  const connection = await input.connect();
  const git = async (argv: string[]) => {
    await assertCurrent();
    if (argv[0] === 'push') await input.reauthorize();
    return (await connection.git(argv)).trim();
  };
  const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
  const branch = await git(['branch', '--show-current']);
  if (!branch || branch === input.base) throw new Error('delivery-branch-required');
  await git(['check-ref-format', `refs/heads/${branch}`]);
  if (
    (await realpath(await git(['rev-parse', '--show-toplevel']))) !==
    (await realpath(record.worktree!))
  )
    throw new Error('delivery-worktree-diverged');
  if (
    ['prepare', 'publish'].includes(action.operation) &&
    (await git(['status', '--porcelain=v1']))
  )
    throw new Error('delivery-uncommitted-work');
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
  const count = Number(
    await git(['rev-list', '--count', `refs/remotes/origin/${input.base}..HEAD`]),
  );
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('delivery-committed-work-required');
  const remotes = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/u);
  if (
    !remotes.length ||
    remotes.some((remote) => gitRemoteIdentity(remote) !== `github.com/${repository.toLowerCase()}`)
  )
    throw new Error('delivery-push-destination-mismatch');
  resolvePullRequestRecipients(input.recipients, intake.assignment.actor);
  const binding = {
    repositoryId: intake.repository.nodeId,
    issueId: intake.issue.nodeId,
    sessionId: record.sessionCreation!.sessionId!,
    threadId: record.threadId!,
    worktree: record.worktree!,
    branch,
    base: input.base,
    head,
    authorId: connection.account.identity.nodeId,
    policyDigest: record.manifestDigest,
  };
  const previous = work.delivery;
  // the commit belongs to this attempt; the issue, session and branch own the delivery.
  const bindingChange =
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
      'policyDigest',
    ]);
  if (bindingChange) throw new Error(bindingChange);
  const title = action.title ?? previous?.title;
  const body = action.body ?? previous?.body;
  if (!title?.trim() || !body?.trim() || title.includes('\0') || body.includes('\0'))
    throw new Error('delivery-authored-content-required');
  if (
    previous?.creationAttempted &&
    !previous.pullRequest &&
    (title !== previous.title || body !== previous.body)
  )
    throw new Error('delivery-content-changed');
  const delivery = previous ?? {
    id: automationHash({ admission: intake.id, session: binding.sessionId }),
    binding,
    title,
    body,
    creationAttempted: false,
    reconciled: false,
  };
  const contentUpdate = {
    ...previous?.contentUpdate,
    ...(previous?.pullRequest && title !== previous.title ? { title } : {}),
    ...(previous?.pullRequest && body !== previous.body ? { body } : {}),
  };
  const digest = automationHash({
    binding,
    title,
    body,
    source: input.source,
    authorization: work.publication,
    previous: previous ?? null,
  });
  if (action.operation === 'prepare')
    return {
      status: 'prepared',
      id: record.id,
      digest,
      operation: { ...delivery, binding, title, body, contentUpdate },
      instructions:
        'Publish only under the retained explicit operator request, using this digest and the same title/body. On an uncertain result, prepare again to reconcile this operation; do not create a replacement PR.',
    };
  const provider = new IssueDeliveryProvider({
    identity: connection.account.identity,
    async execute(...args) {
      await assertCurrent();
      // The fixed provider uses explicit REST methods for writes; its GraphQL lookup is read-only.
      const argv = args[0];
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(argv[argv.indexOf('--method') + 1] ?? ''))
        await input.reauthorize();
      return connection.account.execute(...args);
    },
  });
  const publication: IssueDeliveryInput = {
    item: {
      number: intake.issue.number,
      itemDatabaseId: intake.issue.databaseId,
      itemNodeId: intake.issue.nodeId,
      repositoryOwner: intake.repository.owner.login,
      repositoryName: intake.repository.name,
      repositoryDefaultBranch: input.base,
      assignmentActorLogin: intake.assignment.actor.login,
      assignmentActorNodeId: intake.assignment.actor.nodeId,
    },
    branch,
    title,
    body,
    recipients: input.recipients,
    headSha: head,
    repositoryNodeId: intake.repository.nodeId,
    linkIssue: true,
    contentUpdate: Object.keys(contentUpdate).length ? contentUpdate : undefined,
    signal: input.signal,
    expectedPullRequest: delivery.pullRequest,
    async beforeCreate() {
      await assertCurrent();
      if (delivery.creationAttempted) throw new Error('delivery-creation-uncertain');
      delivery.creationAttempted = true;
      await save();
    },
    async checkpoint(receipt) {
      delivery.pullRequest = receipt;
      await save();
    },
  };
  if (
    action.operation === 'compose' ||
    action.operation === 'candidate' ||
    action.operation === 'announce'
  ) {
    if (!previous?.pullRequest || !previous.reconciled)
      throw new Error('delivery-reconciliation-required');
    const announcement = await deliveryAnnouncement({
      operation: action.operation,
      digest: action.digest,
      publicText: action.publicText,
      delivery: previous,
      publication,
      provider,
      client: new GitHubIssueCommentClient(new GitHubWorkEventApiClient(connection.account), 8000),
      authorId: connection.account.identity.nodeId,
      select: (state) => {
        if (!input.selectAnnouncement) throw new Error('delivery-announcement-skill-unavailable');
        return input.selectAnnouncement(state);
      },
      authorize: async () => {
        await assertCurrent();
        await input.reauthorize();
      },
      save,
    });
    return {
      ...announcement,
      id: record.id,
      url: `https://github.com/${repository}/pull/${previous.pullRequest.pullRequestNumber}`,
    };
  }
  if (action.operation === 'publish') {
    if (action.digest !== digest) throw new Error('delivery-preview-stale');
    delivery.binding = binding;
    delivery.title = title;
    delivery.body = body;
    if (Object.keys(contentUpdate).length) delivery.contentUpdate = contentUpdate;
    delivery.reconciled = false;
    work.delivery = delivery;
    await save();
    const ref = `refs/heads/${branch}`;
    const remoteHead = (await git(['ls-remote', '--heads', 'origin', ref])).split(/\s/u)[0] ?? '';
    if (remoteHead && remoteHead !== head) {
      if (!previous?.pullRequest || remoteHead !== previous.pushedHead)
        throw new Error('delivery-remote-head-diverged');
      await git(['merge-base', '--is-ancestor', remoteHead, head]);
    }
    publication.expectedPullRequest = await provider.inspect({
      ...publication,
      headSha: remoteHead,
    });
    if (remoteHead !== head) await git(['push', '--set-upstream', 'origin', `${head}:${ref}`]);
    if ((await git(['ls-remote', '--heads', 'origin', ref])).split(/\s/u)[0] !== head)
      throw new Error('delivery-push-unverified');
    delivery.pushedHead = head;
    await save();
    await provider.publish(publication);
    delete delivery.contentUpdate;
    delivery.reconciled = true;
    await save();
  } else {
    if (!previous?.pullRequest || !previous.reconciled)
      throw new Error('delivery-reconciliation-required');
    await provider.inspect(publication);
  }
  const receipt = delivery.pullRequest!;
  const url = `https://github.com/${repository}/pull/${receipt.pullRequestNumber}`;
  if (action.operation === 'present') {
    delivery.presentation =
      githubNotificationPullRequestOpenedCard({
        issueNumber: intake.issue.number,
        pullRequestNumber: receipt.pullRequestNumber,
        repositoryOwner: intake.repository.owner.login,
        repositoryName: intake.repository.name,
        commentFlow: input.feedbackEnabled ? 'openclaw' : 'unavailable',
      }) +
      '\n\n' +
      announcementPresentation(
        delivery.announcement,
        `https://github.com/${repository}/issues/${intake.issue.number}`,
      );
    await save();
    return {
      status: 'presented',
      id: record.id,
      url,
      presentation: delivery.presentation,
      instructions:
        'Reproduce the complete quoted PR card in this issue chat. Card generation does not establish visible delivery. Never recreate the PR for a presentation failure.',
    };
  }
  return {
    status: action.operation === 'publish' ? 'published' : 'ready',
    id: record.id,
    pullRequest: receipt,
    url,
    instructions:
      'Call delivery compose, invoke the selected reply skill for the delivery event, submit candidate and execute announce with its preview digest. Then call delivery present and reproduce its full private PR card and announcement outcome. A failed announcement retains the PR; never recreate it.',
  };
}
