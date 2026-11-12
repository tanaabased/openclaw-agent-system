import { verifyDeliveryCommits } from './delivery-base.ts';
import { retainedAnnouncementPublication } from './delivery-announcement-recovery.ts';
import codexIssueNotice from '../../codex-issue-notice.ts';
import invalidDeliveryRequest from '../../../tools/dispatch/delivery-request-error.ts';
import taskPullRequest, { isCurrentTaskPullRequest } from './task-pull-request.ts';
import {
  managedPullRequest,
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
} from '../managed-issue.ts';
import bindIssuePullRequest from './issue-pr-binding.ts';
import { adoptedIssueDelivery } from './delivery-state.ts';
import { retainedIssueProgression } from '../issue-progression.ts';
import workflowStatus from '../workflow-status.ts';
import {
  assertDeliveryBinding,
  selectDeliveryDestination,
  deliveryContentUpdate,
} from './delivery-preparation.ts';
import publishIssueDelivery from './publish-issue-delivery.ts';
import deliveryAnnouncement, {
  announcementPrecedesDelivery,
  announcementPresentation,
  deliveryCompletionInstructions,
} from './delivery-announcement.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import GitHubIssueCommentClient from '../../../channels/github/provider/issue-comment-client.ts';
import GitHubWorkEventApiClient from '../../../channels/github/provider/work-event-api-client.ts';
import { realpath } from 'node:fs/promises';

import { automationHash } from '../../automation-hash.ts';
import type { OpenClawDispatchRecord } from '../dispatch/openclaw-dispatch-state.ts';
import type { OpenClawWorkAction } from '../implementation/openclaw-work.ts';

import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../../../channels/github/publication/issue-delivery.ts';
import resolvePullRequestRecipients from '../../../channels/github/pull-request-recipients.ts';
import { githubNotificationPullRequestOpenedCard } from '../../../channels/github/presentation/pull-request-opened.ts';
import type { GitHubPullRequestRecipient } from '../../../channels/github/workflow-policy.ts';
import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';
import { gitRemoteIdentity } from '../../../tools/git/worktree-remote.ts';

export interface OpenClawDeliveryConnection {
  account: Pick<
    ConnectedGitHubAccountClient,
    'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
  >;
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
  existingOnly?: boolean;
  operator?: boolean;
  expectedLocalBranch?: string;
  selectAnnouncement?(
    state?: DeliveryAnnouncementState,
  ): Promise<NonNullable<DeliveryAnnouncementState['composition']>>;
  connect(): Promise<OpenClawDeliveryConnection>;
  assertCurrent(): Promise<void>;
  reauthorize(): Promise<void>;
  save(): Promise<void>;
  signal: AbortSignal;
  now?: number;
}) {
  const { record, intake, action, assertCurrent } = input;
  if (action.base !== undefined && !['prepare', 'publish'].includes(action.operation))
    throw invalidDeliveryRequest(action.operation, 'openclaw');
  const save = async () => {
    await input.save();
  };
  if (action.pullRequest !== undefined && !['bind', 'link'].includes(action.operation))
    throw invalidDeliveryRequest(action.operation, 'openclaw');
  if (action.operation === 'present')
    return presentOpenClawDelivery(record, intake, input.feedbackEnabled);
  const adoptedPullRequest = managedPullRequest(intake);
  if (record.supersededBy) throw new Error('dispatch-task-superseded');
  if (action.operation === 'link') {
    const unchanged = isCurrentTaskPullRequest(record, intake, action.pullRequest);
    if (action.pullRequest === undefined || unchanged) {
      if (record.pullRequestLink === undefined && record.delivery?.pullRequest)
        record.pullRequestLink = record.delivery.pullRequest;
      await save();
      return { status: 'linked', pullRequest: taskPullRequest(record) };
    }
    if (!input.operator) throw new Error('delivery-link-operator-required');
    await assertCurrent();
    if (action.pullRequest === null) record.pullRequestLink = null;
    else {
      const connection = await input.connect();
      if (connection.account.identity.nodeId !== intake.receiving.nodeId)
        throw new Error('delivery-adoption-account-changed');
      const provider = new IssueDeliveryProvider(connection.account);
      const adopted = await provider.adopt(
        {
          repositoryNodeId: intake.repository.nodeId,
          item: {
            number: intake.issue.number,
            itemNodeId: intake.issue.nodeId,
            itemDatabaseId: intake.issue.databaseId,
            repositoryOwner: intake.repository.owner.login,
            repositoryName: intake.repository.name,
            repositoryDefaultBranch: input.base,
          },
        },
        action.pullRequest,
      );
      record.pullRequestLink = {
        pullRequestNodeId: adopted.pullRequestNodeId,
        pullRequestNumber: adopted.pullRequestNumber,
      };
    }
    await save();
    return { status: 'linked', pullRequest: taskPullRequest(record) };
  }
  if (action.operation === 'bind') {
    if (!input.operator || !action.pullRequest || input.existingOnly)
      throw new Error('delivery-binding-operator-required');
    await assertCurrent();
    const connection = await input.connect();
    if (connection.account.identity.nodeId !== intake.receiving.nodeId)
      throw new Error('delivery-adoption-account-changed');
    const git = async (argv: string[]) => {
      await assertCurrent();
      return (await connection.git(argv)).trim();
    };
    if (
      (await realpath(await git(['rev-parse', '--show-toplevel']))) !==
      (await realpath(record.worktree!))
    )
      throw new Error('delivery-worktree-diverged');
    const localBranch = await git(['branch', '--show-current']);
    if (!localBranch || localBranch === input.base) throw new Error('delivery-branch-required');
    if (input.expectedLocalBranch && localBranch !== input.expectedLocalBranch)
      throw new Error('delivery-branch-diverged');
    await git(['check-ref-format', `refs/heads/${localBranch}`]);
    const verify = () =>
      new IssueDeliveryProvider(connection.account).adopt(
        {
          repositoryNodeId: intake.repository.nodeId,
          item: {
            number: intake.issue.number,
            itemNodeId: intake.issue.nodeId,
            itemDatabaseId: intake.issue.databaseId,
            repositoryOwner: intake.repository.owner.login,
            repositoryName: intake.repository.name,
            repositoryDefaultBranch: input.base,
          },
          signal: input.signal,
        },
        action.pullRequest!,
      );
    const adopted = await verify();
    const head = await git(['rev-parse', '--verify', 'HEAD']);
    const result = await bindIssuePullRequest({
      id: record.id,
      operator: input.source,
      adopted,
      previous: record.delivery,
      localBranch,
      head,
      git,
      verify,
      assertCurrent,
    });
    if (result.retained) return result;
    record.adoptedPullRequest = adopted;
    record.pullRequestLink = {
      pullRequestNodeId: adopted.pullRequestNodeId,
      pullRequestNumber: adopted.pullRequestNumber,
    };
    record.delivery = {
      ...adoptedIssueDelivery({
        id: record.id,
        repositoryId: intake.repository.nodeId,
        issueId: intake.issue.nodeId,
        threadId: record.threadId!,
        worktree: record.worktree!,
        localBranch,
        head,

        adopted,
      }),
      binding: {
        repositoryId: intake.repository.nodeId,
        issueId: intake.issue.nodeId,
        threadId: record.threadId!,
        sessionId: record.sessionCreation!.sessionId!,
        worktree: record.worktree!,
        branch: adopted.branch,
        base: adopted.base,
        head,
        authorId: adopted.authorId,
      },
    };
    await save();
    return result;
  }
  if (
    action.operation === 'compose' ||
    action.operation === 'candidate' ||
    action.operation === 'announce'
  ) {
    await assertCurrent();
    await input.reauthorize();
    const connection = await input.connect();
    const publication = retainedAnnouncementPublication(intake, record, input.signal);
    const provider = new IssueDeliveryProvider(connection.account);
    const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
    const announcement = await deliveryAnnouncement({
      runtime: 'openclaw',
      request: { action: 'delivery', operation: 'compose' },
      material: action.material,
      now: input.now,
      operation: action.operation,
      publicText: action.publicText,
      delivery: record,
      publication,
      provider,
      client: new GitHubIssueCommentClient(new GitHubWorkEventApiClient(connection.account), 8000),
      authorId: connection.account.identity.nodeId,
      authorLogin: connection.account.identity.login,
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
      url: `https://github.com/${repository}/pull/${publication.expectedPullRequest.pullRequestNumber}`,
    };
  }
  if (record.work?.scope === 'local') throw new Error('implementation-publication-not-authorized');
  if (
    ['prepare', 'publish'].includes(action.operation) &&
    !retainedIssueProgression(record) &&
    !input.operator &&
    !record.work?.publication
  )
    throw new Error('delivery-implementation-not-authorized');
  await assertCurrent();
  const connection = await input.connect();
  const git = async (argv: string[]) => {
    await assertCurrent();
    if (argv[0] === 'push') await input.reauthorize();
    return (await connection.git(argv)).trim();
  };
  const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
  if (record.adoptedPullRequest && !record.delivery) {
    const localBranch = (await git(['branch', '--show-current'])).trim();
    if (!localBranch || localBranch === input.base) throw new Error('delivery-branch-required');
    if (!record.adoptedLocalBranch || record.adoptedLocalBranch !== localBranch)
      throw new Error('delivery-branch-diverged');
    const selected = adoptedIssueDelivery({
      id: record.id,
      repositoryId: intake.repository.nodeId,
      issueId: intake.issue.nodeId,
      threadId: record.threadId!,
      worktree: record.worktree!,
      localBranch,
      head: record.adoptedPullRequest.head,

      adopted: record.adoptedPullRequest,
    });
    record.delivery = {
      ...selected,
      binding: { ...selected.binding, sessionId: record.sessionCreation!.sessionId! },
    };
    await save();
  }
  const previous = record.delivery;
  const adopted = previous?.adopted;
  const { base, retainedBase } = selectDeliveryDestination({
    requestedBase: action.base,
    repositoryDefault: input.base,
    selectedBase: adoptedPullRequest?.baseRef ?? adopted?.base,
    previous,
  });
  let branch = await git(['branch', '--show-current']);
  if (previous?.localBranch && branch !== previous.localBranch)
    throw new Error('delivery-branch-diverged');
  if (!branch || branch === base || (!retainedBase && branch === input.base))
    throw new Error('delivery-branch-required');
  await git(['check-ref-format', `refs/heads/${branch}`]);
  branch = adopted?.branch ?? branch;
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
  if (adoptedPullRequest) branch = adoptedPullRequest.headRef;
  const head =
    action.operation === 'reconcile' && previous
      ? previous.pushedHead && previous.reconciled
        ? previous.pushedHead
        : previous.binding.head
      : await git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
  await verifyDeliveryCommits(
    git,
    base,
    head,
    (action.operation === 'prepare' || action.operation === 'publish') &&
      action.base !== undefined &&
      retainedBase === undefined
      ? { repository, operation: action.operation }
      : undefined,
  );
  const remotes = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).split(/\r?\n/u);
  if (
    !remotes.length ||
    remotes.some((remote) => gitRemoteIdentity(remote) !== `github.com/${repository.toLowerCase()}`)
  )
    throw new Error('delivery-push-destination-mismatch');
  if (!adoptedPullRequest && !adopted)
    resolvePullRequestRecipients(
      input.recipients ?? (intake.assignment ? undefined : []),
      intake.assignment?.actor,
    );
  const binding = {
    repositoryId: intake.repository.nodeId,
    issueId: intake.issue.nodeId,
    sessionId: record.sessionCreation!.sessionId!,
    threadId: record.threadId!,
    worktree: record.worktree!,
    branch,
    base,
    head,
    authorId: adopted?.authorId ?? connection.account.identity.nodeId,
  };
  assertDeliveryBinding(previous, binding);
  const existingContent =
    adoptedPullRequest &&
    ((action.title ?? previous?.title) === undefined ||
      (action.body ?? previous?.body) === undefined)
      ? await new IssueDeliveryProvider(connection.account).content({
          repository,
          number: intake.issue.number,
          nodeId: intake.issue.nodeId,
        })
      : undefined;
  const title = action.title ?? previous?.title ?? existingContent?.title;
  const body = action.body ?? previous?.body ?? existingContent?.body;
  if (
    !title?.trim() ||
    body === undefined ||
    (!adoptedPullRequest && !adopted && !body.trim()) ||
    title.includes('\0') ||
    body?.includes('\0')
  )
    throw new Error('delivery-authored-content-required');
  if (
    previous?.creationAttempted &&
    !previous.pullRequest &&
    (title !== previous.title || body !== previous.body)
  )
    throw new Error('delivery-content-changed');
  const delivery: NonNullable<OpenClawDispatchRecord['delivery']> = previous ?? {
    id: automationHash({ admission: intake.id, session: binding.sessionId }),
    binding,
    title,
    body,
    ...(adoptedPullRequest
      ? {
          pullRequest: {
            pullRequestNodeId: intake.issue.nodeId,
            pullRequestNumber: intake.issue.number,
          },
        }
      : {}),
    creationAttempted: false,
    reconciled: false,
  };
  const contentUpdate = deliveryContentUpdate(previous, { title, body });
  if (
    adopted &&
    head === adopted.head &&
    !previous?.pushedHead &&
    !Object.keys(contentUpdate).length
  )
    return {
      status: 'bound',
      id: record.id,
      pullRequest: delivery.pullRequest,
      instructions:
        'The existing PR is selected, but there is no new work to publish. Adoption alone sends no announcement and does not establish implementation completion.',
    };
  if (action.operation === 'prepare')
    return {
      status: 'prepared',
      operation: { ...delivery, binding, title, body, contentUpdate },
      publishRequest: {
        action: 'delivery' as const,
        operation: 'publish' as const,
        title,
        body,
        ...(action.base !== undefined ? { base } : {}),
      },
      instructions:
        'Publish with the authored title and body through native approval when authorized. The runtime resolves the current task, checkout and destination and revalidates them inside publication. Preparation is optional and grants no authority. Honor explicit restrictions and native denials; reconcile uncertain publication through its retained owner.',
    };
  const provider = new IssueDeliveryProvider({
    identity: connection.account.identity,
    observationScope: connection.account.observationScope,
    credentialFingerprint: connection.account.credentialFingerprint,
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
      repositoryDefaultBranch: base,
      assignmentActorLogin: intake.assignment?.actor.login,
      assignmentActorNodeId: intake.assignment?.actor.nodeId,
    },
    branch,
    title,
    body,
    recipients:
      adoptedPullRequest || adopted
        ? []
        : (input.recipients ?? (intake.assignment ? undefined : [])),
    headSha: head,
    repositoryNodeId: intake.repository.nodeId,
    linkIssue: !adoptedPullRequest && !adopted,
    adoptedPullRequest,
    adopted,
    contentUpdate: Object.keys(contentUpdate).length ? contentUpdate : undefined,
    signal: input.signal,
    expectedPullRequest: delivery.pullRequest,
  };
  if (action.operation === 'publish') {
    delivery.binding = binding;
    delivery.title = title;
    delivery.body = body;
    if (Object.keys(contentUpdate).length) {
      if (!delivery.contentUpdate) delivery.contentUpdateAttempted = false;
      delivery.contentUpdate = contentUpdate;
    }
    delivery.reconciled = false;
    record.delivery = delivery;
    await save();
    await publishIssueDelivery({
      delivery,
      publication: { ...publication, headSha: head },
      provider,
      git,
      authorize: async () => {
        await assertCurrent();
        await input.reauthorize();
      },
      beforeCreate: async () => {
        if (input.existingOnly || adopted) throw new Error('feedback-delivery-owner-changed');
      },
      save,
    });
  } else {
    if (!previous) throw new Error('delivery-reconciliation-required');
    if (previous.reconciled) await provider.inspect(publication);
    else {
      const remote = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).split(
        /\s/u,
      )[0];
      // reconciliation never pushes newer local work or recreates an uncertain PR.
      if (remote !== head) throw new Error('delivery-publication-required');
      await publishIssueDelivery({
        delivery: previous,
        publication: { ...publication, headSha: head },
        provider,
        git,
        push: async () => {
          throw new Error('delivery-publication-required');
        },
        authorize: async () => {
          await assertCurrent();
          await input.reauthorize();
        },
        beforeCreate: async () => {
          if (input.existingOnly || adopted) throw new Error('feedback-delivery-owner-changed');
        },
        save,
      });
    }
  }
  const receipt = delivery.pullRequest!;
  const url = `https://github.com/${repository}/pull/${receipt.pullRequestNumber}`;

  return {
    status: action.operation === 'publish' ? 'published' : 'ready',
    id: record.id,
    pullRequest: receipt,
    workflowStatus: workflowStatus(record),
    url,
    linkRequest: { action: 'delivery' as const, operation: 'link' as const },
    instructions: deliveryCompletionInstructions(
      'openclaw',
      record,
      action.operation === 'publish' && Boolean(previous?.reconciled && previous.pullRequest),
    ),
  };
}

/** Display a retained receipt without reacquiring publication permission or contacting GitHub. */
export function presentOpenClawDelivery(
  record: OpenClawDispatchRecord,
  intake: IntakeRecord,
  feedbackEnabled: boolean,
) {
  const delivery = record.delivery;
  const receipt = taskPullRequest(record);
  if (!receipt) throw new Error('delivery-reconciliation-required');
  const linkedDelivery =
    delivery?.pullRequest?.pullRequestNodeId === receipt.pullRequestNodeId ? delivery : undefined;
  const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
  const url = `https://github.com/${repository}/pull/${receipt.pullRequestNumber}`;

  const incomplete = linkedDelivery && !linkedDelivery.reconciled;
  const updatedSinceAnnouncement = announcementPrecedesDelivery(
    linkedDelivery && { ...linkedDelivery, announcement: record.announcement },
  );
  const notice = incomplete
    ? codexIssueNotice({ event: 'failure', changed: true, code: 'delivery-publication-incomplete' })
    : undefined;
  const presentation =
    githubNotificationPullRequestOpenedCard({
      issueNumber: managedPullRequest(intake) ? undefined : intake.issue.number,
      updated: updatedSinceAnnouncement,
      pullRequestNumber: receipt.pullRequestNumber,
      repositoryOwner: intake.repository.owner.login,
      repositoryName: intake.repository.name,
      commentFlow: feedbackEnabled ? 'openclaw' : 'unavailable',
    }) +
    '\n\n' +
    announcementPresentation(
      record.announcement,
      managedTargetUrl(intake),
      undefined,
      record.announcementRecovery,
    ) +
    (notice ? '\n\n' + notice.message : '');
  return {
    status: incomplete ? 'publication-incomplete' : 'presented',
    retained: true,
    workflowStatus: workflowStatus(record),
    id: record.id,
    url,
    presentation,
    instructions:
      'Reproduce the complete quoted PR card in this issue chat. Card generation does not establish visible delivery. Never recreate the PR for a presentation failure.',
  };
}
