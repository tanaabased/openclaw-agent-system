import { managedPullRequest, managedTargetUrl, dispatchAdmission } from './managed-issue.ts';

import bindIssuePullRequest from './issue-pr-binding.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import authorizeCodexFeedback from './codex-feedback-authority.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import { feedbackMode } from './feedback-work.ts';
import issueProgression from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { notificationAuthorityDigest } from './notification-authority.ts';
import workflowStatus from './workflow-status.ts';
import deliveryBindingChange from './delivery-binding-change.ts';
import publishIssueDelivery from './publish-issue-delivery.ts';
import codexIssueBranch from './codex-issue-branch.ts';
import workflowFailure from './workflow-failure.ts';
import deliveryAnnouncement, {
  announcementPresentation,
  deliveryCompletionInstructions,
} from './delivery-announcement.ts';
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
import { dispatchGit, verifyDispatchWorktree, type DispatchGit } from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import { adoptedCodexDelivery, type CodexDeliveryState } from './codex-delivery-state.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake, type CodexIntakeDependencies } from './codex-intake.ts';
import { connectCodexThreads, type CodexThreadRequest } from './codex-thread-client.ts';
import { requireWorkflowSchedule, type WorkflowScheduleAuthority } from './workflow-result.ts';
import workflowInstructions from '../channels/github/presentation/workflow-instructions.ts';
import { githubNotificationPullRequestOpenedCard } from '../channels/github/presentation/pull-request-opened.ts';
import { workflowFeedbackAvailable } from '../channels/github/feedback-policy.ts';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../channels/github/publication/issue-delivery.ts';
import resolvePullRequestRecipients, {
  issuePullRequestRecipients,
} from '../channels/github/pull-request-recipients.ts';

const requestSchema = Type.Object(
  {
    action: Type.Union(
      [
        'bind',
        'prepare',
        'publish',
        'reconcile',
        'present',
        'compose',
        'candidate',
        'announce',
      ].map((value) => Type.Literal(value)),
    ),
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    eventId: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    digest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    pullRequest: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    publicText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
type DeliveryRequest = Static<typeof requestSchema>;
export interface CodexDeliveryDependencies extends Omit<CodexIntakeDependencies, 'connect'> {
  activation?: typeof inspectCodexDispatchActivation;
  feedbackConnect?: typeof connectCodexFeedback;
  connect?: typeof connectCodexGitHubAccount;
  git?: DispatchGit;
  delay?: typeof abortableDelay;
  native?: Pick<ReturnType<typeof codexDispatchNative>, 'find'> &
    Partial<Pick<ReturnType<typeof codexDispatchNative>, 'assessmentSkill' | 'operatorInput'>>;
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
  if (input.pullRequest !== undefined && input.action !== 'bind')
    throw new Error('delivery-request-invalid');
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
        (record.supersededBy && input.action !== 'present') ||
        (!['present', 'reconcile'].includes(input.action) &&
          (record.reset || record.retired || record.retirement))
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
      const intake = dispatchAdmission(record, (await current.store.read())?.records ?? []);
      if (!intake) throw new Error('delivery-admission-missing');
      const adoptedPullRequest = managedPullRequest(intake);
      const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
      const previous = record.delivery;
      if (input.action === 'bind') {
        if (!input.pullRequest || input.eventId || deps.schedule || !native.operatorInput)
          throw new Error('delivery-binding-operator-required');
        const operator = await native.operatorInput(caller!);
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
          record,
        );
        if (connected.account.identity.nodeId !== intake.receiving.nodeId)
          throw new Error('delivery-adoption-account-changed');
        await verifyDispatchWorktree(record.project, found.cwd, repository, git, 'handoff');
        const adopted = await new IssueDeliveryProvider(connected.account, deps.delay).adopt(
          {
            repositoryNodeId: intake.repository.nodeId,
            item: {
              number: intake.issue.number,
              itemDatabaseId: intake.issue.databaseId,
              itemNodeId: intake.issue.nodeId,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              repositoryDefaultBranch: checked.repo.defaultBranch,
            },
            signal,
          },
          input.pullRequest,
        );
        const localBranch = (await git(found.cwd, ['branch', '--show-current'], signal)).trim();
        if (
          !localBranch ||
          localBranch === checked.repo.defaultBranch ||
          (record.issueBranch && record.issueBranch.name !== localBranch) ||
          state.records.some(
            (other) =>
              other.id !== record.id &&
              other.project?.commonDir === record.project!.commonDir &&
              (other.issueBranch?.name === localBranch ||
                (other.delivery?.localBranch ?? other.delivery?.binding.branch) === localBranch),
          )
        )
          throw new Error('codex-branch-owner-mismatch');
        for (const branch of [localBranch, adopted.branch, adopted.base])
          await git(found.cwd, ['check-ref-format', `refs/heads/${branch}`], signal);
        const head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
        const bindingResult = await bindIssuePullRequest({
          id: record.id,
          digest: input.digest,
          operator,
          adopted,
          previous,
          localBranch,
          head,
          git: (argv) => git(found.cwd, argv, signal),
          assertCurrent: async () => {
            const latest = await native.operatorInput!(caller!);
            if (latest.turnId !== operator.turnId || latest.inputId !== operator.inputId)
              throw new Error('delivery-binding-stale');
          },
          verify: () =>
            new IssueDeliveryProvider(connected.account, deps.delay).adopt(
              {
                repositoryNodeId: intake.repository.nodeId,
                item: {
                  number: intake.issue.number,
                  itemDatabaseId: intake.issue.databaseId,
                  itemNodeId: intake.issue.nodeId,
                  repositoryOwner: intake.repository.owner.login,
                  repositoryName: intake.repository.name,
                  repositoryDefaultBranch: checked.repo.defaultBranch,
                },
                signal,
              },
              input.pullRequest!,
            ),
        });
        if (bindingResult.status !== 'bound' || bindingResult.retained) return { ...bindingResult };
        if (previous) (record.deliveryHistory ??= []).push(previous);
        record.issueBranch = { attemptId: record.id, name: localBranch, phase: 'ready' };
        record.adoptedPullRequest = adopted;
        record.delivery = adoptedCodexDelivery({
          id: record.id,
          repositoryId: intake.repository.nodeId,
          issueId: intake.issue.nodeId,
          threadId: record.threadId,
          worktree: record.worktree,
          localBranch,
          adopted,
          head,
          policyDigest: notificationAuthorityDigest(current.manifest.github?.notifications),
        });
        await save();
        return { ...bindingResult };
      }
      const notices = (attached: boolean) =>
        [
          ...new Set([
            ...(record.delivery?.notices ?? []),
            ...(!attached ? ['delivery-attachment-pending'] : []),
          ]),
        ]
          .filter(
            (code) =>
              code !== 'delivery-ssh-transport' &&
              (code !== 'delivery-linkage-retried' || current.manifest.debug),
          )
          .map((code) => codexIssueNotice({ event: 'failure', changed: true, code }));
      const url = (number: number) => `https://github.com/${repository}/pull/${number}`;
      if (input.action === 'present' || input.action === 'reconcile') {
        if (!previous?.pullRequest) throw new Error('delivery-reconciliation-required');
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
        let commentFlow: 'codex' | 'unavailable' | 'unverified' = 'unavailable';
        const policy = current.manifest.github?.notifications;
        if (workflowFeedbackAvailable(policy, 'issue-assignment')) {
          commentFlow = 'unverified';
          try {
            const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
              pluginData,
              { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
              false,
              false,
              'feedback',
            );
            if (activation.schedule) {
              requireWorkflowSchedule(
                activation.schedule.saved,
                activation.schedule.current,
                'feedback',
              );
              commentFlow = 'codex';
            }
          } catch {
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
              current.manifestSources?.['/github/issue-assignment/implementation/guidance']?.path ??
              current.manifestPath,
          },
        );
        const presentationNotices = notices(previous.attached);
        previous.cardAttempts++;
        await save();
        return {
          status: 'linked',
          retained: true,
          workflowStatus: workflowStatus(record),
          instruction:
            'Reproduce the complete presentation Markdown below in your final reply, including the PR card and all notices, without a code fence. Do not replace it with a summary or a claim that the card was verified. This result establishes card generation, not visible delivery. Put any additional verification notes after the cards.',
          notices: presentationNotices,
          url: pullRequestUrl,
          pullRequest: previous.pullRequest,
          presentation: [
            githubNotificationPullRequestOpenedCard({
              issueNumber: adoptedPullRequest ? undefined : intake.issue.number,
              updated: Boolean(adoptedPullRequest),
              pullRequestNumber: previous.pullRequest.pullRequestNumber,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              commentFlow,
            }),
            ...(implementationInstructions ? [implementationInstructions] : []),
            announcementPresentation(previous.announcement, managedTargetUrl(intake)),
            ...presentationNotices.map((notice) => notice.message),
          ].join('\n\n'),
        };
      }
      const feedbackEvent = record.feedback?.events.find(
        (event) => event.attempt?.turnId === found.turnId,
      );
      if (feedbackEvent && input.eventId !== feedbackEvent.id)
        throw new Error('feedback-event-required');
      if (input.eventId && feedbackEvent?.id !== input.eventId)
        throw new Error('feedback-owner-caller-required');
      const authorizePublication = async () => {
        await deps.authorizeSchedule?.();
        if (!input.eventId) return;
        const event = feedbackEvent!;
        if (
          !event.work ||
          event.work.result?.outcome !== 'done' ||
          !event.work.head ||
          ['blocked', 'published'].includes(event.phase)
        )
          throw new Error('feedback-implementation-result-required');
        if (
          event.work.pullRequest &&
          automationHash(record.delivery?.pullRequest) !== automationHash(event.work.pullRequest)
        )
          throw new Error('feedback-delivery-owner-changed');
        const live = await selectCodexIntake(pluginData, { ...deps, connect: undefined });
        feedbackMode(record, live.manifest.github!.notifications!);
        const activated = await (deps.activation ?? inspectCodexDispatchActivation)(
          pluginData,
          { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
          false,
          true,
          'feedback',
        );
        if (!activated.schedule) throw new Error('feedback-schedule-owner-changed');
        requireWorkflowSchedule(activated.schedule.saved, activated.schedule.current, 'feedback');
        await authorizeCodexFeedback({
          current: live,
          record,
          event,
          intake,
          provider: await (deps.feedbackConnect ?? connectCodexFeedback)(current.workspace, signal),
        });
        if (
          (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim() !==
          event.work.head
        )
          throw new Error('feedback-implementation-head-changed');
      };
      if (input.eventId) await authorizePublication();
      else if (deps.schedule) {
        await authorizePublication();
        if (
          record.continuation &&
          (record.continuation.phase !== 'delivery' ||
            record.continuation.result?.outcome !== 'done')
        )
          throw new Error('delivery-continuation-stopped');
        if (deps.schedule.current.workflow !== 'issue-assignment')
          throw new Error('delivery-schedule-binding-mismatch');
        requireWorkflowSchedule(deps.schedule.saved, deps.schedule.current, 'publication');
      } else {
        if (
          !record.handoff &&
          record.continuation &&
          (record.continuation.phase !== 'delivery' ||
            record.continuation.result?.outcome !== 'done')
        )
          throw new Error('delivery-continuation-stopped');
        const transition = issueProgression(record, {
          mode:
            record.manualIssue?.selections?.mode ??
            current.manifest.github?.notifications?.issueAssignment?.mode ??
            'auto',
          now: (deps.now ?? Date.now)(),
        });
        if (
          transition.status === 'stopped' &&
          !(transition.reason === 'implementation-cancelled' && record.handoff)
        )
          throw new Error(transition.reason);
        if (transition.status === 'ready') record.progression = transition.progression;
        else if (record.handoff || found.followUpUserTurn)
          record.progression ??= {
            stage: 'implementation',
            via: 'operator',
          };
        else throw new WorkflowPolicyHeld('implementation-disabled');
      }
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
        record,
      );
      const policyDigest =
        previous?.binding.policyDigest ??
        notificationAuthorityDigest(current.manifest.github?.notifications);
      const announcementOnly = ['compose', 'candidate', 'announce'].includes(input.action);
      if (announcementOnly && (!previous?.pullRequest || !previous.reconciled))
        throw new Error('delivery-reconciliation-required');
      const adopted = previous?.adopted ?? record.adoptedPullRequest;
      let localBranch = previous?.localBranch;
      let branch = previous?.binding.branch ?? '';
      let head = previous?.binding.head ?? '';
      if (!announcementOnly) {
        await verifyDispatchWorktree(record.project, found.cwd, repository, git, 'handoff');
        branch = (await git(found.cwd, ['branch', '--show-current'], signal)).trim();
        if (!branch || branch === (adoptedPullRequest?.baseRef ?? checked.repo.defaultBranch))
          throw new Error('delivery-branch-required');
        await codexIssueBranch({
          record,
          records: state.records,
          intake,
          workspace: current.workspace,
          agentId: current.manifest.agent.id,
          git,
          signal,
          save,
        });
        await git(found.cwd, ['check-ref-format', `refs/heads/${branch}`], signal);
        if (previous?.localBranch && branch !== previous.localBranch)
          throw new Error('codex-branch-owner-mismatch');
        localBranch = adopted ? branch : undefined;
        branch = adopted?.branch ?? branch;
        if (await git(found.cwd, ['status', '--porcelain=v1'], signal))
          throw new Error('delivery-uncommitted-work');
        if (adoptedPullRequest) branch = adoptedPullRequest.headRef;
        head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
        if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
        const count = Number(
          await git(
            found.cwd,
            [
              'rev-list',
              '--count',
              `refs/remotes/origin/${adoptedPullRequest?.baseRef ?? adopted?.base ?? checked.repo.defaultBranch}..HEAD`,
            ],
            signal,
          ),
        );
        if (!Number.isSafeInteger(count) || count < 1)
          throw new Error('delivery-committed-work-required');
      }
      if (!announcementOnly && !adoptedPullRequest && !adopted)
        await new GitHubIdentityCache(current.store.location).resolve(
          current.manifest.github?.notifications,
          connected.client,
          'delivery',
        );
      const recipients =
        input.eventId && previous?.pullRequest
          ? []
          : current.manifest.github?.notifications !== undefined
            ? issuePullRequestRecipients(
                current.manifest.github.notifications,
                Boolean(record.manualIssue),
              )
            : undefined;
      if (!announcementOnly && !adoptedPullRequest && !adopted)
        resolvePullRequestRecipients(
          recipients ?? (intake.assignment ? undefined : []),
          intake.assignment?.actor,
        );
      const binding = {
        repositoryId: intake.repository.nodeId,
        issueId: intake.issue.nodeId,
        threadId: record.threadId,
        worktree: record.worktree,
        branch,
        base: adoptedPullRequest?.baseRef ?? adopted?.base ?? checked.repo.defaultBranch,
        head,
        authorId: adopted?.authorId ?? connected.account.identity.nodeId,
        policyDigest,
      };
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
        title:
          input.title ??
          previous?.title ??
          (adoptedPullRequest ? JSON.parse(record.context!).title : undefined),
        body:
          input.body ??
          previous?.body ??
          (adoptedPullRequest ? JSON.parse(record.context!).body : undefined),
        creationAttempted: previous?.creationAttempted ?? false,
        ...(adopted
          ? {
              adopted,
              localBranch,
              pullRequest: {
                pullRequestNodeId: adopted.pullRequestNodeId,
                pullRequestNumber: adopted.pullRequestNumber,
              },
            }
          : {}),
        ...(previous?.pushedHead ? { pushedHead: previous.pushedHead } : {}),
        ...(previous?.pendingPush ? { pendingPush: previous.pendingPush } : {}),
        ...(previous?.pullRequest
          ? { pullRequest: previous.pullRequest }
          : adoptedPullRequest
            ? {
                pullRequest: {
                  pullRequestNodeId: intake.issue.nodeId,
                  pullRequestNumber: intake.issue.number,
                },
              }
            : {}),
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
      if (adopted && head === adopted.head && !previous?.pushedHead && !delivery.contentUpdate)
        return {
          status: 'bound',
          id: input.id,
          pullRequest: delivery.pullRequest,
          instruction:
            'The existing PR is selected, but there is no new work to publish. Adoption alone sends no announcement and does not establish implementation completion.',
        };
      const digest = automationHash({ delivery, turnId: found.turnId, previous });

      if (
        input.action === 'compose' ||
        input.action === 'candidate' ||
        input.action === 'announce'
      ) {
        if (!previous?.pullRequest || !previous.reconciled)
          throw new Error('delivery-reconciliation-required');
        const policy = current.manifest.github?.notifications;
        if (!policy) throw new Error('delivery-policy-required');
        const publication: IssueDeliveryInput = {
          item: {
            number: intake.issue.number,
            itemDatabaseId: intake.issue.databaseId,
            itemNodeId: intake.issue.nodeId,
            repositoryOwner: intake.repository.owner.login,
            repositoryName: intake.repository.name,
            repositoryDefaultBranch: adoptedPullRequest?.baseRef ?? checked.repo.defaultBranch,
          },
          branch,
          headSha: head,
          repositoryNodeId: intake.repository.nodeId,
          expectedPullRequest: previous.pullRequest,
          adoptedPullRequest,
          adopted,
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
          authorLogin: connected.account.identity.login,
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
            await authorizePublication();
            await revalidateDispatchAssignment(
              current,
              intake,
              { connect: async () => connected.client },
              signal,
              true,
            );
          },
          save,
        });
        return { ...announce, id: input.id, url: url(previous.pullRequest.pullRequestNumber) };
      }
      if (input.action === 'prepare' || (input.action === 'publish' && input.digest !== digest))
        return {
          status: 'prepared',
          ...(input.action === 'publish'
            ? { code: 'delivery-preview-stale', refreshed: true }
            : {}),
          id: input.id,
          digest,
          operation: delivery,
          instruction:
            (input.action === 'publish'
              ? 'This stale preview made no publication write. Inspect the refreshed operation and retry once with its digest only within the existing authorization; investigate repeated staleness. '
              : '') +
            (deps.schedule
              ? 'The activated workflow and verified continuation authorize publication. Publish through the owning continuationRuntime with this digest and the same title/body; no additional stage approval is required. Native execution review still applies.'
              : 'The verified implementation stage or current user direction authorizes ordinary PR delivery and appropriate follow-up commits. Do not ask for a separate publication grant; honor explicit user restrictions. Execute delivery publish with this id and digest through native approval, retaining title/body if supplied. Preparation does not grant permission and a native denial stops the operation.'),
        };
      if (input.action === 'publish') {
        await authorizePublication();
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
              repositoryDefaultBranch: adoptedPullRequest?.baseRef ?? checked.repo.defaultBranch,
              assignmentActorLogin: intake.assignment?.actor.login,
              assignmentActorNodeId: intake.assignment?.actor.nodeId,
            },
            branch,
            title: delivery.title,
            body: delivery.body,
            signal,
            recipients:
              adoptedPullRequest || adopted
                ? []
                : (recipients ?? (intake.assignment ? undefined : [])),
            expectedPullRequest: delivery.pullRequest,
            adopted,
            headSha: head,
            repositoryNodeId: intake.repository.nodeId,
            linkIssue: !adoptedPullRequest && !adopted,
            adoptedPullRequest,
            contentUpdate: delivery.contentUpdate,
            onLinkageRetry: async () => {
              delivery.notices = [
                ...new Set([...(delivery.notices ?? []), 'delivery-linkage-retried' as const]),
              ];
              await save();
            },
          };
          const provider = new IssueDeliveryProvider(
            {
              identity: connected.account.identity,
              observationScope: connected.account.observationScope,
              credentialFingerprint: connected.account.credentialFingerprint,
              execute: async (...args) => {
                const argv = args[0];
                if (
                  ['POST', 'PATCH', 'PUT', 'DELETE'].includes(
                    argv[argv.indexOf('--method') + 1] ?? '',
                  )
                )
                  await authorizePublication();
                return connected.account.execute(...args);
              },
            },
            deps.delay,
          );
          await publishIssueDelivery({
            delivery,
            publication: { ...publication, headSha: head },
            provider,
            git: (argv) => git(found.cwd, argv, signal),
            push: async (head, ref, remotes) => {
              const transport = remotes.flatMap((remote) => {
                const preferred = preferGitHubSshWorktreeRemote(remote);
                return preferred === remote ? [] : ['-c', `url.${preferred}.insteadOf=${remote}`];
              });
              await git(
                found.cwd,
                [...transport, 'push', '--set-upstream', 'origin', `${head}:${ref}`],
                signal,
              );
            },
            authorize: authorizePublication,
            beforeCreate: async () => {
              if (feedbackEvent?.work?.pullRequest)
                throw new Error('feedback-delivery-owner-changed');
            },
            save,
          });
          return {
            status: 'published',
            notices: notices(delivery.attached),
            id: input.id,
            pullRequest: delivery.pullRequest,
            workflowStatus: workflowStatus({ phase: 'complete', delivery }),
            url: url(delivery.pullRequest!.pullRequestNumber),
            instruction: deliveryCompletionInstructions('codex', delivery),
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
      throw new Error('delivery-action-invalid');
    }, true);
  } finally {
    await connection?.close();
  }
}
