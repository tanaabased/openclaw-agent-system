import {
  selectCodexTaskContext,
  type CodexTaskContextDependencies,
} from '../context/codex-task-context.ts';
import { withDispatchTask } from '../../dispatch-task-scope.ts';
import { deliveryBaseSchema, verifyDeliveryCommits } from './delivery-base.ts';
import { retainedAnnouncementPublication } from './delivery-announcement-recovery.ts';
import { realpath } from 'node:fs/promises';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { workflowFeedbackAvailable } from '../../../channels/github/feedback-policy.ts';
import GitHubIdentityCache from '../../../channels/github/identity-cache.ts';
import { cardCopyInstructions } from '../../../channels/github/presentation/card.ts';
import { githubNotificationPullRequestOpenedCard } from '../../../channels/github/presentation/pull-request-opened.ts';
import GitHubIssueCommentClient from '../../../channels/github/provider/issue-comment-client.ts';
import GitHubWorkEventApiClient from '../../../channels/github/provider/work-event-api-client.ts';
import IssueDeliveryProvider, {
  type IssueDeliveryInput,
} from '../../../channels/github/publication/issue-delivery.ts';
import resolvePullRequestRecipients, {
  issuePullRequestRecipients,
} from '../../../channels/github/pull-request-recipients.ts';
import invalidDeliveryRequest from '../../../tools/dispatch/delivery-request-error.ts';
import { implementationMaterialSchema } from '../../../tools/dispatch/implementation-material-schema.ts';
import resolveGitProtocol from '../../../tools/git/protocol.ts';
import { githubWorktreeRemote } from '../../../tools/git/worktree-remote.ts';
import type abortableDelay from '../../../utils/abortable-delay.ts';
import { nativeObject } from '../../automation-gateway.ts';
import { automationHash } from '../../automation-hash.ts';
import { inspectCodexDispatchActivation } from '../../codex-automations.ts';
import codexCommit from '../../codex-commit.ts';
import { adoptedCodexDelivery, type IssueDeliveryState } from './issue-delivery-state.ts';
import { revalidateDispatchAssignment } from '../../codex-dispatch-context.ts';
import dispatchHistory from '../../codex-dispatch-history.ts';
import { codexDispatchNative } from '../../codex-dispatch-native.ts';
import {
  dispatchGit,
  verifyDispatchWorktree,
  type DispatchGit,
} from '../../codex-dispatch-project.ts';
import CodexDispatchStore from '../../codex-dispatch-state.ts';
import authorizeCodexFeedback from '../../codex-feedback-authority.ts';
import connectCodexFeedback from '../../codex-feedback-client.ts';
import connectCodexGitHubAccount from '../../codex-github-client.ts';
import codexHostAccess from '../../codex-host-access.ts';
import codexIssueBranch from '../../codex-issue-branch.ts';
import codexIssueNotice from '../../codex-issue-notice.ts';
import { connectCodexThreads, type CodexThreadRequest } from '../../codex-thread-client.ts';
import deliveryAnnouncement, {
  announcementPrecedesDelivery,
  announcementPresentation,
  deliveryCompletionInstructions,
} from './delivery-announcement.ts';
import {
  assertDeliveryBinding,
  selectDeliveryDestination,
  deliveryContentUpdate,
} from './delivery-preparation.ts';
import selectFeedbackStage from '../../feedback-stage.ts';
import bindIssuePullRequest from './issue-pr-binding.ts';
import issueProgression from '../../issue-progression.ts';
import issueWorkflowMode from '../../issue-workflow-mode.ts';
import { WorkflowPolicyHeld } from '../../live-workflow-policy.ts';
import { dispatchAdmission, managedPullRequest, managedTargetUrl } from '../../managed-issue.ts';
import publishIssueDelivery from './publish-issue-delivery.ts';
import taskPullRequest, {
  isCurrentTaskPullRequest,
  setTaskPullRequestLink,
} from './task-pull-request.ts';
import workflowFailure from '../../workflow-failure.ts';
import {
  requireWorkflowSchedule,
  type WorkflowScheduleAuthority,
} from '../../workflow-schedule.ts';
import workflowStatus from '../../workflow-status.ts';
const requestSchema = Type.Object(
  {
    action: Type.Union(
      [
        'link',
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
    pullRequest: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    ),
    material: Type.Optional(implementationMaterialSchema),
    publicText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    base: Type.Optional(deliveryBaseSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
type DeliveryRequest = Static<typeof requestSchema>;
export interface CodexDeliveryDependencies extends CodexTaskContextDependencies {
  now?: () => number;
  activation?: typeof inspectCodexDispatchActivation;
  feedbackConnect?: typeof connectCodexFeedback;
  connect?: typeof connectCodexGitHubAccount;
  git?: DispatchGit;
  delay?: typeof abortableDelay;
  native?: Pick<ReturnType<typeof codexDispatchNative>, 'find'> &
    Partial<Pick<ReturnType<typeof codexDispatchNative>, 'assessmentSkill' | 'operatorInput'>>;
  attachment?: (threadId: string, turnId: string, url: string) => Promise<boolean | undefined>;
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
    readonly pullRequest?: IssueDeliveryState['pullRequest'],
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
): Promise<boolean | undefined> {
  const turns = await dispatchHistory(request, threadId);
  const turn = turns.find((entry) => entry.id === turnId);
  if (!turn || !Array.isArray(turn.items)) return undefined;
  const calls = turn.items.filter(
    (item) =>
      nativeObject(item) &&
      item.type === 'mcpToolCall' &&
      item.server === 'codex_app' &&
      item.tool === 'list_artifacts',
  );
  const call = calls.at(-1);
  if (!nativeObject(call) || call.status !== 'completed' || !nativeObject(call.result))
    return undefined;
  const result = call.result;
  if (result.isError === true || !Array.isArray(result.content)) return undefined;
  const content = result.content.find(
    (entry) => nativeObject(entry) && entry.type === 'text' && typeof entry.text === 'string',
  );
  if (!nativeObject(content) || typeof content.text !== 'string') return undefined;
  let inventory: unknown;
  try {
    inventory = JSON.parse(content.text);
  } catch {
    return undefined;
  }
  if (!nativeObject(inventory) || !Array.isArray(inventory.artifacts)) return undefined;
  return inventory.artifacts.some(
    (entry) =>
      nativeObject(entry) &&
      entry.attachmentType === 'pull_request' &&
      (entry.identityKey === url || (nativeObject(entry.payload) && entry.payload.url === url)),
  );
}
/** publication runs only through an explicitly approved native command; preparation is read-only. */
export default function runCodexDelivery(...args: Parameters<typeof runCodexDeliveryScoped>) {
  const deps = args[2] ?? {};
  return withDispatchTask('codex', deps.threadId ?? process.env.CODEX_THREAD_ID, () =>
    runCodexDeliveryScoped(...args),
  );
}
async function runCodexDeliveryScoped(
  pluginData: string,
  request: unknown,
  deps: CodexDeliveryDependencies = {},
) {
  if (!Value.Check(requestSchema, request)) {
    const fields = nativeObject(request) ? request : {};
    const invalid = Object.entries(requestSchema.properties)
      .filter(
        ([key, schema]) =>
          (fields[key] !== undefined ||
            requestSchema.required?.some((required) => required === key)) &&
          !Value.Check(schema, fields[key]),
      )
      .map(([key]) => key);
    const unsupported = Object.keys(fields).some(
      (key) => !Object.hasOwn(requestSchema.properties, key),
    );
    throw invalidDeliveryRequest(
      fields.action,
      'codex',
      `invalid delivery request${invalid.length ? `; missing or invalid fields: ${invalid.join(', ')}` : ''}${unsupported ? '; unsupported fields supplied' : ''}`,
    );
  }
  const input: DeliveryRequest = request;
  if (
    input.material &&
    (input.action !== 'compose' ||
      input.publicText ||
      input.title ||
      input.body ||
      input.pullRequest !== undefined)
  )
    throw invalidDeliveryRequest(input.action, 'codex');
  if (input.base !== undefined && !['prepare', 'publish'].includes(input.action))
    throw invalidDeliveryRequest(input.action, 'codex');
  if (input.pullRequest !== undefined && !['bind', 'link'].includes(input.action))
    throw invalidDeliveryRequest(input.action, 'codex');
  if (input.title?.includes('\0') || input.body?.includes('\0'))
    throw invalidDeliveryRequest(input.action, 'codex');
  const current = await selectCodexTaskContext(pluginData, {
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
  const commitOptions = {
    ...codexCommit(current.policy?.policy.maxConcurrentItems, input.id, 'delivery'),
    operation: 'delivery-checkpoint' as const,
  };
  try {
    return await store.transaction(async (state, checkpoint, signal) => {
      const record = state.records.find((entry) => entry.id === input.id);
      if (
        !record?.request ||
        !record.project ||
        !record.worktree ||
        !record.threadId ||
        record.threadId !== caller ||
        (record.supersededBy && input.action !== 'present') ||
        (!['present', 'reconcile'].includes(input.action) && (record.reset || record.retirement))
      )
        throw new Error('delivery-managed-issue-required');
      const save = async () => {
        await checkpoint();
      };
      const found = await native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      });
      const conversationOnly = ['link', 'present', 'compose', 'candidate', 'announce'].includes(
        input.action,
      );
      if (
        !found ||
        found.id !== caller ||
        !found.turnId ||
        (!conversationOnly && (await realpath(found.cwd)) !== (await realpath(record.worktree)))
      )
        throw new Error('delivery-native-binding-mismatch');
      const intake = dispatchAdmission(record, (await current.store.read())?.records ?? []);
      if (!intake) throw new Error('delivery-admission-missing');
      const adoptedPullRequest = managedPullRequest(intake);
      const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
      const previous = record.delivery;
      if (input.action === 'link') {
        if (deps.schedule) throw new Error('delivery-link-operator-required');
        const unchanged = isCurrentTaskPullRequest(record, intake, input.pullRequest);
        if (input.pullRequest !== undefined && !unchanged) {
          if (input.eventId || !native.operatorInput)
            throw new Error('delivery-link-operator-required');
          await native.operatorInput(caller!);
          if (input.pullRequest === null) record.pullRequestLink = null;
          else {
            const connected = await (deps.connect ?? connectCodexGitHubAccount)(
              current.workspace,
              signal,
            );
            if (connected.account.identity.nodeId !== intake.receiving.nodeId)
              throw new Error('delivery-adoption-account-changed');
            await setTaskPullRequestLink(record, intake, input.pullRequest, connected.client);
          }
        } else if (record.pullRequestLink === undefined && previous?.pullRequest) {
          record.pullRequestLink = previous.pullRequest;
        }
        await save();
        const linked = taskPullRequest(record);
        if (!linked) return { status: 'unlinked' as const, attachment: 'unchanged' as const };
        const pullRequestUrl = `https://github.com/${repository}/pull/${linked.pullRequestNumber}`;
        let attached: boolean | undefined;
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
        if (
          previous?.pullRequest?.pullRequestNodeId === linked.pullRequestNodeId &&
          attached !== undefined &&
          previous.attached !== attached
        ) {
          previous.attached = attached;
          await save();
        }
        return {
          status: 'linked' as const,
          pullRequest: linked,
          attached,
          url: pullRequestUrl,
          instructions: attached
            ? 'Native attachment is confirmed.'
            : 'Call native attach_artifact with this pull_request URL, then list_artifacts and delivery link to reconcile attachment. Card and announcement operations are independent.',
        };
      }
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
        if (bindingResult.retained) return { ...bindingResult };
        record.issueBranch = { attemptId: record.id, name: localBranch, phase: 'ready' };
        record.adoptedPullRequest = adopted;
        record.pullRequestLink = {
          pullRequestNodeId: adopted.pullRequestNodeId,
          pullRequestNumber: adopted.pullRequestNumber,
        };
        record.delivery = adoptedCodexDelivery({
          id: record.id,
          repositoryId: intake.repository.nodeId,
          issueId: intake.issue.nodeId,
          threadId: record.threadId,
          worktree: record.worktree,
          localBranch,
          adopted,
          head,
        });
        await save();
        return { ...bindingResult };
      }
      const notices = (attached?: boolean) =>
        [
          ...new Set([
            ...(record.delivery?.notices ?? []),
            ...(record.delivery?.pullRequest && !record.delivery.reconciled
              ? ['delivery-publication-incomplete']
              : []),
            ...(attached === false ? ['delivery-attachment-pending'] : []),
          ]),
        ]
          .filter(
            (code) =>
              code !== 'delivery-ssh-transport' &&
              (code !== 'delivery-linkage-retried' ||
                (current.manifest.debug && record.delivery?.reconciled)),
          )
          .map((code) => codexIssueNotice({ event: 'failure', changed: true, code }));
      const url = (number: number) => `https://github.com/${repository}/pull/${number}`;
      if (input.action === 'present' || input.action === 'reconcile') {
        const linked = taskPullRequest(record);
        if (!linked) throw new Error('delivery-reconciliation-required');
        const pullRequestUrl = url(linked.pullRequestNumber);
        if (
          !previous?.pullRequest ||
          linked.pullRequestNodeId !== previous.pullRequest.pullRequestNodeId
        ) {
          if (input.action === 'reconcile') {
            const attached = deps.attachment
              ? await deps.attachment(record.threadId, found.turnId, pullRequestUrl)
              : await codexDeliveryAttachment(
                  connection!.request,
                  record.threadId,
                  found.turnId,
                  pullRequestUrl,
                );
            return {
              status: 'linked' as const,
              pullRequest: linked,
              attached,
              url: pullRequestUrl,
              instructions: attached
                ? 'Native attachment is confirmed.'
                : 'Call native attach_artifact with this pull_request URL, then list_artifacts and delivery link to reconcile attachment. Card and announcement operations are independent.',
            };
          }
          return {
            status: 'presented' as const,
            pullRequest: linked,
            presentation: githubNotificationPullRequestOpenedCard({
              issueNumber: intake.issue.number,
              pullRequestNumber: linked.pullRequestNumber,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              commentFlow: 'unverified',
            }),
          };
        }
        if (input.action === 'reconcile') {
          let attached = previous.attached;
          try {
            const observed = deps.attachment
              ? await deps.attachment(record.threadId, found.turnId, pullRequestUrl)
              : await codexDeliveryAttachment(
                  connection!.request,
                  record.threadId,
                  found.turnId,
                  pullRequestUrl,
                );
            if (observed !== undefined) attached = observed;
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
        const presentationNotices = notices(previous.attached);
        const updatedSinceAnnouncement = announcementPrecedesDelivery({
          ...previous,
          announcement: record.announcement,
        });
        await save();
        return {
          status: previous.reconciled ? 'linked' : 'publication-incomplete',
          retained: true,
          workflowStatus: workflowStatus(record),
          instruction:
            cardCopyInstructions +
            ' Reproduce the complete presentation Markdown below in your final reply, including the PR card and all notices, without a code fence. Do not replace it with a summary or a claim that the card was verified. This result establishes card generation, not visible delivery. Put any additional verification notes after the cards.',
          notices: presentationNotices,
          url: pullRequestUrl,
          pullRequest: previous.pullRequest,
          presentation: [
            githubNotificationPullRequestOpenedCard({
              issueNumber: adoptedPullRequest ? undefined : intake.issue.number,
              updated: updatedSinceAnnouncement,
              pullRequestNumber: previous.pullRequest.pullRequestNumber,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              commentFlow,
            }),
            announcementPresentation(
              record.announcement,
              managedTargetUrl(intake),
              undefined,
              record.announcementRecovery,
            ),
            ...presentationNotices.map((notice) => notice.message),
          ].join('\n\n'),
        };
      }
      const feedbackEvent = record.feedback?.events.find(
        (event) => event.attempt?.turnId === found.turnId,
      );
      if (input.eventId && feedbackEvent?.id !== input.eventId)
        throw new Error('feedback-owner-caller-required');
      const announcementOnly = ['compose', 'candidate', 'announce'].includes(input.action);
      const authorizePublication = async () => {
        await deps.authorizeSchedule?.();
        if (!feedbackEvent) return;
        const live = await selectCodexTaskContext(pluginData, deps);
        await authorizeCodexFeedback({
          conversation: true,
          current: live,
          record,
          event: feedbackEvent,
          intake,
          provider: await (deps.feedbackConnect ?? connectCodexFeedback)(current.workspace, signal),
        });
      };
      await authorizePublication();
      if (deps.schedule) {
        if (deps.schedule.current.workflow !== 'issue-assignment')
          throw new Error('delivery-schedule-binding-mismatch');
        requireWorkflowSchedule(deps.schedule.saved, deps.schedule.current, 'publication');
      }
      if (!announcementOnly) {
        const transition = issueProgression(record, {
          mode: issueWorkflowMode(current.manifest.github?.notifications, record),
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
      if (
        input.action === 'compose' ||
        input.action === 'candidate' ||
        input.action === 'announce'
      ) {
        const policy = current.manifest.github?.notifications;
        if (!policy) throw new Error('delivery-policy-required');
        const publication = retainedAnnouncementPublication(intake, record, signal);
        const announce = await deliveryAnnouncement({
          runtime: 'codex',
          request: { action: 'compose' },
          material: input.material,
          now: (deps.now ?? Date.now)(),
          operation: input.action,
          publicText: input.publicText,
          delivery: record,
          publication,
          provider: new IssueDeliveryProvider(connected.account, deps.delay),
          client: new GitHubIssueCommentClient(
            new GitHubWorkEventApiClient(connected.account),
            8000,
          ),
          authorId: connected.account.identity.nodeId,
          authorLogin: connected.account.identity.login,
          select: async (retained) => {
            return (
              await selectFeedbackStage({
                policy,
                workflow: 'issue-assignment',
                workspace: current.workspace,
                observedAt: retained?.composition?.observedAt ?? Date.now(),
                retained: input.action === 'compose' ? undefined : retained?.composition,
                resolveSkill: (id) => {
                  if (!native.assessmentSkill)
                    throw new Error('delivery-announcement-skill-unavailable');
                  return native.assessmentSkill(found.cwd, id);
                },
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
        return {
          ...announce,
          id: input.id,
          url: url(publication.expectedPullRequest.pullRequestNumber),
        };
      }
      const adopted = previous?.adopted ?? record.adoptedPullRequest;
      const { base, retainedBase } = selectDeliveryDestination({
        requestedBase: input.base,
        repositoryDefault: checked.repo.defaultBranch,
        selectedBase: adoptedPullRequest?.baseRef ?? adopted?.base,
        previous,
      });
      await verifyDispatchWorktree(record.project, found.cwd, repository, git, 'handoff');
      const checkedOutBranch = (await git(found.cwd, ['branch', '--show-current'], signal)).trim();
      let branch = checkedOutBranch;
      if (!branch || branch === base || (!retainedBase && branch === checked.repo.defaultBranch))
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
      if (previous?.localBranch && branch !== previous.localBranch)
        throw new Error('codex-branch-owner-mismatch');
      const localBranch = adopted || adoptedPullRequest ? branch : undefined;
      branch = adopted?.branch ?? branch;
      if (await git(found.cwd, ['status', '--porcelain=v1'], signal))
        throw new Error('delivery-uncommitted-work');
      if (adoptedPullRequest) branch = adoptedPullRequest.headRef;
      const head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
      await verifyDeliveryCommits(
        (argv) => git(found.cwd, argv, signal),
        base,
        head,
        input.action === 'publish' && input.base !== undefined && retainedBase === undefined
          ? repository
          : undefined,
      );
      if (!adoptedPullRequest && !adopted)
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
      if (!adoptedPullRequest && !adopted)
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
        base,
        head,
        authorId: adopted?.authorId ?? connected.account.identity.nodeId,
      };
      if (
        deps.schedule &&
        !previous?.creationAttempted &&
        ['prepare', 'publish'].includes(input.action) &&
        !(input.body ?? previous?.body)?.trim()
      )
        throw new Error('delivery-body-required');
      assertDeliveryBinding(previous, binding);
      const existingContent =
        adoptedPullRequest &&
        ((input.title ?? previous?.title) === undefined ||
          (input.body ?? previous?.body) === undefined)
          ? await new IssueDeliveryProvider(connected.account, deps.delay).content({
              repository,
              number: intake.issue.number,
              nodeId: intake.issue.nodeId,
              signal,
            })
          : undefined;
      const delivery: IssueDeliveryState = {
        id: previous?.id ?? automationHash({ admission: intake.id, threadId: record.threadId }),
        binding,
        title: input.title ?? previous?.title ?? existingContent?.title,
        body: input.body ?? previous?.body ?? existingContent?.body,
        creationAttempted: previous?.creationAttempted ?? false,
        ...(localBranch ? { localBranch } : {}),
        ...(adopted
          ? {
              adopted,
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
        notices: previous?.notices ?? [],
      };
      if (
        ['prepare', 'publish'].includes(input.action) &&
        previous?.creationAttempted &&
        !previous.pullRequest &&
        (delivery.title !== previous.title || delivery.body !== previous.body)
      )
        throw new Error('delivery-content-changed');
      const contentUpdate = deliveryContentUpdate(previous, delivery);
      if (Object.keys(contentUpdate).length) {
        delivery.contentUpdate = contentUpdate;
        delivery.contentUpdateAttempted = previous?.contentUpdate
          ? previous.contentUpdateAttempted
          : false;
      }
      if (adopted && head === adopted.head && !previous?.pushedHead && !delivery.contentUpdate)
        return {
          status: 'bound',
          id: input.id,
          pullRequest: delivery.pullRequest,
          instruction:
            'The existing PR is selected, but there is no new work to publish. Adoption alone sends no announcement and does not establish implementation completion.',
        };
      if (input.action === 'prepare')
        return {
          status: 'prepared',
          operation: delivery,
          publishRequest: {
            action: 'publish' as const,
            title: delivery.title,
            body: delivery.body,
            ...(input.base !== undefined ? { base } : {}),
          },
          currentPullRequest: taskPullRequest(record),
          instruction:
            'Publish with the authored title and body through native approval when authorized. The runtime resolves the current task, checkout and destination and revalidates them inside publication. Preparation is optional and grants no authority. Honor explicit restrictions and native denials; reconcile uncertain publication through its retained owner.',
        };
      if (input.action === 'publish') {
        await authorizePublication();
        record.issueBranch = { attemptId: record.id, name: checkedOutBranch, phase: 'ready' };
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
              repositoryDefaultBranch: base,
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
                const preferred = githubWorktreeRemote(
                  remote,
                  resolveGitProtocol(current.manifest),
                );
                return preferred === remote ? [] : ['-c', `url.${preferred}.insteadOf=${remote}`];
              });
              await git(
                found.cwd,
                [...transport, 'push', '--set-upstream', 'origin', `${head}:${ref}`],
                signal,
              );
            },
            authorize: authorizePublication,
            save,
          });
          return {
            status: 'published',
            notices: notices(),
            id: input.id,
            pullRequest: delivery.pullRequest,
            linkRequest: { action: 'link' as const },
            workflowStatus: workflowStatus(record),
            url: url(delivery.pullRequest!.pullRequestNumber),
            instruction: deliveryCompletionInstructions(
              'codex',
              { ...record, attached: delivery.attached },
              Boolean(previous?.reconciled && previous.pullRequest),
            ),
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
    }, commitOptions);
  } finally {
    await connection?.close();
  }
}
