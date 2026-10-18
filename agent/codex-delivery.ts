import deliveryBindingChange from './delivery-binding-change.ts';
import workflowFailure from './workflow-failure.ts';
import deliveryAnnouncement, { announcementPresentation } from './delivery-announcement.ts';
import selectFeedbackStage from './feedback-stage.ts';
import GitHubIssueCommentClient from '../channels/github/provider/issue-comment-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import { realpath } from 'node:fs/promises';

import { preferGitHubSshWorktreeRemote } from '../tools/git/worktree-remote.ts';
import type abortableDelay from '../utils/abortable-delay.ts';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import { nativeObject } from './automation-gateway.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import dispatchHistory from './codex-dispatch-history.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import {
  dispatchGit,
  githubOrigin,
  verifyDispatchWorktree,
  type DispatchGit,
} from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { revalidateDispatchAssignment } from './codex-dispatch.ts';
import type { CodexDeliveryState } from './codex-delivery-state.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake, type CodexIntakeDependencies } from './codex-intake.ts';
import { connectCodexThreads, type CodexThreadRequest } from './codex-thread-client.ts';
import { requireWorkflowSchedule, type WorkflowScheduleAuthority } from './workflow-result.ts';
import workflowInstructions from '../channels/github/presentation/workflow-instructions.ts';
import { githubNotificationPullRequestOpenedCard } from '../channels/github/presentation/pull-request-opened.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../channels/github/publication/issue-delivery.ts';
import resolvePullRequestRecipients from '../channels/github/pull-request-recipients.ts';

const requestSchema = Type.Object(
  {
    action: Type.Union(
      ['prepare', 'publish', 'reconcile', 'present', 'compose', 'candidate', 'announce'].map(
        (value) => Type.Literal(value),
      ),
    ),
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    digest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    publicText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
type DeliveryRequest = Static<typeof requestSchema>;
export interface CodexDeliveryDependencies extends Omit<CodexIntakeDependencies, 'connect'> {
  activation?: typeof inspectCodexDispatchActivation;
  connect?: typeof connectCodexGitHubAccount;
  git?: DispatchGit;
  delay?: typeof abortableDelay;
  native?: Pick<ReturnType<typeof codexDispatchNative>, 'find'> &
    Partial<Pick<ReturnType<typeof codexDispatchNative>, 'assessmentSkill'>>;
  attachment?: (threadId: string, turnId: string, url: string) => Promise<boolean>;
  threadId?: string;
  // only the owning continuation runtime may supply verified schedule state, never request json.
  authorizeSchedule?: () => Promise<void>;
  schedule?: {
    saved: WorkflowScheduleAuthority;
    current: Omit<WorkflowScheduleAuthority, 'version' | 'capabilities'>;
  };
}

export class CodexDeliveryFailure extends Error {
  constructor(
    error: unknown,
    readonly code: string,
    readonly notices: Array<ReturnType<typeof codexIssueNotice>>,
    readonly pullRequest?: CodexDeliveryState['pullRequest'],
  ) {
    super(error instanceof Error ? error.message : code, { cause: error });
  }
}

/** only successful native inventory readback in the owning turn establishes attachment. */
export async function codexDeliveryAttachment(
  request: CodexThreadRequest,
  threadId: string,
  turnId: string,
  url: string,
): Promise<boolean> {
  const turns = await dispatchHistory(request, threadId);
  const turn = turns.find((entry) => entry.id === turnId);
  if (!turn || !Array.isArray(turn.items)) return false;
  const calls = turn.items.filter(
    (item) =>
      nativeObject(item) &&
      item.type === 'mcpToolCall' &&
      item.server === 'codex_app' &&
      item.tool === 'list_artifacts',
  );
  const call = calls.at(-1);
  if (!nativeObject(call) || call.status !== 'completed' || !nativeObject(call.result))
    return false;
  const result = call.result;
  if (result.isError === true || !Array.isArray(result.content)) return false;
  const content = result.content.find(
    (entry) => nativeObject(entry) && entry.type === 'text' && typeof entry.text === 'string',
  );
  if (!nativeObject(content) || typeof content.text !== 'string') return false;
  let inventory: unknown;
  try {
    inventory = JSON.parse(content.text);
  } catch {
    return false;
  }
  return (
    nativeObject(inventory) &&
    Array.isArray(inventory.artifacts) &&
    inventory.artifacts.some(
      (entry) =>
        nativeObject(entry) &&
        entry.attachmentType === 'pull_request' &&
        (entry.identityKey === url || (nativeObject(entry.payload) && entry.payload.url === url)),
    )
  );
}

/** publication runs only through an explicitly approved native command; preparation is read-only. */
export default async function runCodexDelivery(
  pluginData: string,
  request: unknown,
  deps: CodexDeliveryDependencies = {},
) {
  if (!Value.Check(requestSchema, request)) throw new Error('delivery-request-invalid');
  const input: DeliveryRequest = request;
  if (input.title?.includes('\0') || input.body?.includes('\0'))
    throw new Error('delivery-request-invalid');
  const current = await selectCodexIntake(pluginData, {
    codexHome: deps.codexHome,
    inspectBinding: deps.inspectBinding,
  });
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const git = deps.git ?? dispatchGit;
  const connection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  try {
    return await store.exclusive(async (state, save, signal) => {
      const record = state.records.find((entry) => entry.id === input.id);
      if (
        !record?.request ||
        !record.project ||
        !record.worktree ||
        !record.threadId ||
        record.threadId !== caller ||
        record.reset ||
        record.retired
      )
        throw new Error('delivery-managed-issue-required');
      const found = await native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      });
      if (
        !found ||
        found.id !== caller ||
        !found.turnId ||
        (await realpath(found.cwd)) !== (await realpath(record.worktree))
      )
        throw new Error('delivery-native-binding-mismatch');
      if (deps.schedule) {
        await deps.authorizeSchedule?.();
        if (
          record.continuation &&
          (record.continuation.phase !== 'delivery' ||
            record.continuation.result?.outcome !== 'done')
        )
          throw new Error('delivery-continuation-stopped');
        if (
          deps.schedule.current.workflow !== 'issue-assignment' ||
          deps.schedule.current.sourceThreadId !== record.sourceThreadId
        )
          throw new Error('delivery-schedule-binding-mismatch');
        requireWorkflowSchedule(deps.schedule.saved, deps.schedule.current, 'publication');
      } else if (!record.handoff || !found.followUpUserTurn)
        throw new Error('delivery-human-publication-required');
      const intake = (await current.store.read())?.records.find(
        (entry) => entry.id === record.intakeId,
      );
      if (!intake) throw new Error('delivery-admission-missing');
      const connected = await (deps.connect ?? connectCodexGitHubAccount)(
        current.workspace,
        signal,
      );
      const checked = await revalidateDispatchAssignment(
        current,
        intake,
        { connect: async () => connected.client },
        signal,
        true,
        false,
      );
      const policyDigest = automationHash(current.manifest.github?.notifications ?? null);
      if (deps.schedule && deps.schedule.current.policyDigest !== policyDigest)
        throw new Error('delivery-schedule-stale');
      const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
      await verifyDispatchWorktree(record.project, found.cwd, repository, git, 'handoff');
      const branch = (await git(found.cwd, ['branch', '--show-current'], signal)).trim();
      if (!branch || branch === checked.repo.defaultBranch)
        throw new Error('delivery-branch-required');
      await git(found.cwd, ['check-ref-format', `refs/heads/${branch}`], signal);
      if (
        ['prepare', 'publish'].includes(input.action) &&
        (await git(found.cwd, ['status', '--porcelain=v1'], signal))
      )
        throw new Error('delivery-uncommitted-work');
      const head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
      const count = Number(
        await git(
          found.cwd,
          ['rev-list', '--count', `refs/remotes/origin/${checked.repo.defaultBranch}..HEAD`],
          signal,
        ),
      );
      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error('delivery-committed-work-required');
      const recipients =
        current.manifest.github?.notifications?.schemaVersion === 2
          ? current.manifest.github.notifications.issueAssignment?.pullRequest?.recipients
          : undefined;
      resolvePullRequestRecipients(recipients, intake.assignment.actor);
      const binding = {
        repositoryId: intake.repository.nodeId,
        issueId: intake.issue.nodeId,
        threadId: record.threadId,
        worktree: record.worktree,
        branch,
        base: checked.repo.defaultBranch,
        head,
        authorId: connected.account.identity.nodeId,
        policyDigest,
      };
      const previous = record.delivery;
      if (
        deps.schedule &&
        !previous?.creationAttempted &&
        ['prepare', 'publish'].includes(input.action) &&
        !(input.body ?? previous?.body)?.trim()
      )
        throw new Error('delivery-body-required');
      const bindingChange =
        previous &&
        deliveryBindingChange(previous.binding, binding, [
          'repositoryId',
          'issueId',
          'threadId',
          'worktree',
          'branch',
          'base',
          'authorId',
        ]);
      if (bindingChange) throw new Error(bindingChange);
      const delivery: CodexDeliveryState = {
        id: previous?.id ?? automationHash({ admission: intake.id, threadId: record.threadId }),
        binding,
        title: input.title ?? previous?.title,
        body: input.body ?? previous?.body,
        creationAttempted: previous?.creationAttempted ?? false,
        ...(previous?.pushedHead ? { pushedHead: previous.pushedHead } : {}),
        ...(previous?.pullRequest ? { pullRequest: previous.pullRequest } : {}),
        reconciled: false,
        attached: previous?.attached ?? false,
        cardAttempts: previous?.cardAttempts ?? 0,
        ...(previous?.announcement ? { announcement: previous.announcement } : {}),
        notices: previous?.notices ?? [],
      };
      if (
        ['prepare', 'publish'].includes(input.action) &&
        previous?.creationAttempted &&
        !previous.pullRequest &&
        (delivery.title !== previous.title || delivery.body !== previous.body)
      )
        throw new Error('delivery-content-changed');
      const contentUpdate = {
        ...previous?.contentUpdate,
        ...(previous?.pullRequest && delivery.title !== previous.title
          ? { title: delivery.title }
          : {}),
        ...(previous?.pullRequest && delivery.body !== previous.body
          ? { body: delivery.body }
          : {}),
      };
      if (Object.keys(contentUpdate).length) delivery.contentUpdate = contentUpdate;
      const digest = automationHash({ delivery, turnId: found.turnId, previous });
      const notices = (attached: boolean) =>
        [
          ...new Set([
            ...(record.delivery?.notices ?? []),
            ...(!attached ? ['delivery-attachment-pending'] : []),
          ]),
        ]
          .filter((code) => code !== 'delivery-ssh-transport')
          .map((code) => codexIssueNotice({ event: 'failure', changed: true, code }));
      const url = (number: number) => `https://github.com/${repository}/pull/${number}`;
      if (
        input.action === 'compose' ||
        input.action === 'candidate' ||
        input.action === 'announce'
      ) {
        if (!previous?.pullRequest || !previous.reconciled)
          throw new Error('delivery-reconciliation-required');
        const policy = current.manifest.github?.notifications;
        if (policy?.schemaVersion !== 2) throw new Error('delivery-policy-required');
        const publication: IssueDeliveryInput = {
          item: {
            number: intake.issue.number,
            itemDatabaseId: intake.issue.databaseId,
            itemNodeId: intake.issue.nodeId,
            repositoryOwner: intake.repository.owner.login,
            repositoryName: intake.repository.name,
            repositoryDefaultBranch: checked.repo.defaultBranch,
          },
          branch,
          headSha: head,
          repositoryNodeId: intake.repository.nodeId,
          expectedPullRequest: previous.pullRequest,
          signal,
        };
        const announce = await deliveryAnnouncement({
          operation: input.action,
          digest: input.digest,
          publicText: input.publicText,
          delivery: previous,
          publication,
          provider: new IssueDeliveryProvider(connected.account, deps.delay),
          client: new GitHubIssueCommentClient(
            new GitHubWorkEventApiClient(connected.account),
            8000,
          ),
          authorId: connected.account.identity.nodeId,
          select: async (retained) => {
            if (!native.assessmentSkill) throw new Error('delivery-announcement-skill-unavailable');
            return (
              await selectFeedbackStage({
                policy,
                workflow: 'issue-assignment',
                workspace: current.workspace,
                observedAt: retained?.composition.observedAt ?? Date.now(),
                resolveSkill: (id) => native.assessmentSkill!(found.cwd, id),
              })
            ).selection;
          },
          authorize: async () => {
            signal.throwIfAborted();
            await deps.authorizeSchedule?.();
            await revalidateDispatchAssignment(
              current,
              intake,
              { connect: async () => connected.client },
              signal,
              true,
              false,
            );
          },
          save,
        });
        return { ...announce, id: input.id, url: url(previous.pullRequest.pullRequestNumber) };
      }
      if (input.action === 'prepare')
        return {
          status: 'prepared',
          id: input.id,
          digest,
          operation: delivery,
          instruction: deps.schedule
            ? 'The activated workflow and verified continuation authorize publication. Publish through the owning continuationRuntime with this digest and the same title/body; no additional stage approval is required. Native execution review still applies.'
            : 'Only after explicit human publication authorization, execute delivery publish with this id and digest through native approval. Retain title/body if supplied. Automatic callers require freshly reconciled schedule authority. Preparation does not grant publication permission.',
        };
      if (input.action === 'publish') {
        if (input.digest !== digest) throw new Error('delivery-preview-stale');
        await deps.authorizeSchedule?.();
        record.delivery = delivery;
        await save();
        try {
          const publication: IssueDeliveryInput = {
            item: {
              number: intake.issue.number,
              itemDatabaseId: intake.issue.databaseId,
              itemNodeId: intake.issue.nodeId,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              repositoryDefaultBranch: checked.repo.defaultBranch,
              assignmentActorLogin: intake.assignment.actor.login,
              assignmentActorNodeId: intake.assignment.actor.nodeId,
            },
            branch,
            title: delivery.title,
            body: delivery.body,
            signal,
            recipients,
            expectedPullRequest: delivery.pullRequest,
            headSha: head,
            repositoryNodeId: intake.repository.nodeId,
            linkIssue: true,
            contentUpdate: delivery.contentUpdate,
            onLinkageRetry: async () => {
              delivery.notices = [
                ...new Set([...(delivery.notices ?? []), 'delivery-linkage-retried' as const]),
              ];
              await save();
            },
            beforeCreate: async () => {
              await deps.authorizeSchedule?.();
              if (delivery.creationAttempted) throw new Error('delivery-creation-uncertain');
              delivery.creationAttempted = true;
              await save();
            },
            checkpoint: async (receipt) => {
              delivery.pullRequest = receipt;
              await save();
            },
          };
          const provider = new IssueDeliveryProvider(connected.account, deps.delay);
          const remoteRef = `refs/heads/${branch}`;
          const remote = (
            await git(found.cwd, ['ls-remote', '--heads', 'origin', remoteRef], signal)
          ).trim();
          const remoteHead = remote.split(/\s/u)[0] ?? '';
          if (remote && remoteHead !== head) {
            if (!previous?.pullRequest || remoteHead !== previous.pushedHead)
              throw new Error('delivery-remote-head-diverged');
            await git(found.cwd, ['merge-base', '--is-ancestor', remoteHead!, head], signal);
          }
          publication.expectedPullRequest = await provider.inspect({
            ...publication,
            headSha: remoteHead,
          });
          const pushUrls = (
            await git(found.cwd, ['remote', 'get-url', '--push', '--all', 'origin'], signal)
          )
            .trim()
            .split(/\r?\n/u);
          const repository =
            `${intake.repository.owner.login}/${intake.repository.name}`.toLowerCase();
          if (pushUrls.some((value) => githubOrigin(value) !== repository))
            throw new Error('delivery-push-destination-mismatch');
          if (remoteHead !== head) {
            const transport = pushUrls.flatMap((remote) => {
              const preferred = preferGitHubSshWorktreeRemote(remote);
              return preferred === remote ? [] : ['-c', `url.${preferred}.insteadOf=${remote}`];
            });
            await deps.authorizeSchedule?.();
            await git(
              found.cwd,
              [...transport, 'push', '--set-upstream', 'origin', `${head}:${remoteRef}`],
              signal,
            );
          }
          if (
            (await git(found.cwd, ['ls-remote', '--heads', 'origin', remoteRef], signal))
              .trim()
              .split(/\s/u)[0] !== head
          )
            throw new Error('delivery-push-unverified');
          delivery.pushedHead = head;
          await save();
          await deps.authorizeSchedule?.();
          await provider.publish(publication);
          delete delivery.contentUpdate;
          delivery.reconciled = true;
          await save();
          return {
            status: 'published',
            notices: notices(delivery.attached),
            id: input.id,
            pullRequest: delivery.pullRequest,
            url: url(delivery.pullRequest!.pullRequestNumber),
            instruction:
              'Call native attach_artifact for this pull_request URL in this chat, then list_artifacts, then ' +
              (deps.schedule
                ? 'continuationRuntime action:delivery with nested delivery reconcile and present'
                : 'delivery reconcile and present') +
              '. Also call delivery compose, invoke the selected reply skill, submit candidate, and execute announce with its preview digest before final presentation. Keep these actions in the owning continuationRuntime for automatic workflows. Announcement failure never discards the PR or blocks its private card. Never recreate the PR for an attachment, announcement or card failure.',
          };
        } catch (error) {
          signal.throwIfAborted();
          if (codexHostAccess(error)) throw error;
          const evidence = workflowFailure(error, 'delivery-provider-failed');
          const { code } = evidence;
          const notice = codexIssueNotice({
            event: 'failure',
            changed: true,
            ...evidence,
            ...(delivery.pullRequest
              ? {
                  facts: [
                    {
                      label: 'Pull request',
                      value: `[${repository}#${delivery.pullRequest.pullRequestNumber}](${url(delivery.pullRequest.pullRequestNumber)})`,
                    },
                  ],
                }
              : {}),
          });
          throw new CodexDeliveryFailure(
            error,
            code,
            [notice, ...notices(true)],
            delivery.pullRequest,
          );
        }
      }
      if (!previous?.pullRequest || automationHash(previous.binding) !== automationHash(binding))
        throw new Error('delivery-reconciliation-required');
      const pullRequestUrl = url(previous.pullRequest.pullRequestNumber);
      if (input.action === 'reconcile') {
        let attached = false;
        try {
          attached = deps.attachment
            ? await deps.attachment(record.threadId, found.turnId, pullRequestUrl)
            : await codexDeliveryAttachment(
                connection!.request,
                record.threadId,
                found.turnId,
                pullRequestUrl,
              );
        } catch {
          signal.throwIfAborted();
        }
        previous.attached = attached;
        await save();
        return {
          status: previous.reconciled ? 'ready' : 'publication-incomplete',
          notices: notices(attached),
          url: pullRequestUrl,
          pullRequest: previous.pullRequest,
        };
      }
      if (!previous.reconciled) throw new Error('delivery-reconciliation-required');
      let commentFlow: 'codex' | 'unavailable' | 'unverified' = 'unavailable';
      const policy = current.manifest.github?.notifications;
      if (
        policy?.schemaVersion === 2 &&
        feedbackIdentities(policy.issueAssignment?.allowed ?? [], policy.issueAssignment?.feedback)
          .length
      ) {
        commentFlow = 'unverified';
        try {
          const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            false,
            'feedback',
          );
          if (activation.schedule && activation.sourceThreadId === record.sourceThreadId) {
            requireWorkflowSchedule(
              activation.schedule.saved,
              activation.schedule.current,
              'feedback',
            );
            if (activation.schedule.current.policyDigest === policyDigest) commentFlow = 'codex';
          }
        } catch (error) {
          if (codexHostAccess(error)) throw error;
          // presentation cannot claim active feedback when schedule readback fails.
        }
      }
      const implementationInstructions = workflowInstructions(
        'Implementation',
        record.continuation?.selection,
        current.workspace,
        {
          debug: current.manifest.debug,
          manifestPath:
            current.manifestSources?.[
              '/github/notifications/issue-assignment/implementation/guidance'
            ]?.path ?? current.manifestPath,
        },
      );
      const presentationNotices = notices(previous.attached);
      previous.cardAttempts++;
      await save();
      return {
        status: 'linked',
        instruction:
          'Reproduce the complete presentation Markdown below in your final reply, including the PR card and all notices, without a code fence. Do not replace it with a summary or a claim that the card was verified. This result establishes card generation, not visible delivery. Put any additional verification notes after the cards.',
        notices: presentationNotices,
        url: pullRequestUrl,
        pullRequest: previous.pullRequest,
        presentation: [
          githubNotificationPullRequestOpenedCard({
            issueNumber: intake.issue.number,
            pullRequestNumber: previous.pullRequest.pullRequestNumber,
            repositoryOwner: intake.repository.owner.login,
            repositoryName: intake.repository.name,
            commentFlow,
          }),
          ...(implementationInstructions ? [implementationInstructions] : []),
          announcementPresentation(
            previous.announcement,
            `https://github.com/${repository}/issues/${intake.issue.number}`,
          ),
          ...presentationNotices.map((notice) => notice.message),
        ].join('\n\n'),
      };
    }, true);
  } finally {
    await connection?.close();
  }
}
