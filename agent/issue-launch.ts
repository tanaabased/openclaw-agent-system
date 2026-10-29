import { assertDispatchStorage } from './dispatch-storage.ts';
import { issueChatTitleGuidance } from './issue-chat-title.ts';
import IssueDeliveryProvider, {
  type GitHubNotificationIssueDeliveryReceipt,
} from '../channels/github/publication/issue-delivery.ts';
import manualPullRequest from './manual-pull-request.ts';
import initialModelRouting from './initial-model-routing.ts';
import { routingInstructionsDigest } from './routing-instructions.ts';
import { issuePullRequestRecipients } from '../channels/github/pull-request-recipients.ts';
import { githubOrigin } from './codex-dispatch-project.ts';
import type { LaunchRequest } from '../tools/dispatch/launch-schema.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import { automationHash } from './automation-hash.ts';
import dispatchContext from './dispatch-context.ts';
import type DispatchStore from './dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { issueKey } from './dispatch-pending.ts';
import issueLaunchTarget from './issue-launch-target.ts';
import managedOwner from './managed-owner.ts';
import type { OperatorIssue } from './managed-issue.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';

type ExistingDelivery = { pullRequest?: GitHubNotificationIssueDeliveryReceipt };

/** manual admission joins the existing dispatch journal; no assignment or scheduler effects. */
export default async function issueLaunch<
  R extends SharedDispatchRecord & {
    delivery?: ExistingDelivery;
    work?: { delivery?: ExistingDelivery };
  },
>(input: {
  action: LaunchRequest;
  context: AssessmentEntryDependencies;
  journal: DispatchStore<R>;
  scope: string;
  client: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
  create(
    record: Pick<
      SharedDispatchRecord,
      | 'id'
      | 'manualIssue'
      | 'issueKey'
      | 'sourceThreadId'
      | 'phase'
      | 'createdAt'
      | 'manifestDigest'
      | 'context'
    >,
  ): R;
  verifyExisting(record: R): Promise<void>;
}) {
  const { action, context, journal, client } = input;
  if (!context.operator) throw new Error('launch-operator-required');
  await context.assertCurrent();
  const currentTarget = context.currentTarget
    ? issueLaunchTarget(context.currentTarget)
    : undefined;
  let repository = action.repository ?? currentTarget?.repository;
  if (!repository && /^#?[1-9][0-9]*$/u.test(action.target.trim()) && action.projects) {
    const origins = new Set<string>();
    for (const project of action.projects) {
      if (
        !project ||
        typeof project !== 'object' ||
        !('path' in project) ||
        typeof project.path !== 'string'
      )
        throw new Error('launch-project-mapping-invalid');
      const origin = githubOrigin(await context.git(project.path, ['remote', 'get-url', 'origin']));
      if (origin) origins.add(origin);
    }
    if (origins.size === 1) repository = [...origins][0];
  }
  const target = issueLaunchTarget(action.target, repository);
  if (!target)
    return {
      status: 'clarification-needed' as const,
      questions: ['Which owner/repository contains this issue?'],
    };
  if (
    currentTarget &&
    (target.repository.toLowerCase() !== currentTarget.repository.toLowerCase() ||
      target.number !== currentTarget.number ||
      ('itemType' in target && target.itemType !== currentTarget.itemType))
  )
    throw new Error('launch-managed-target-mismatch');
  const [owner, name] = target.repository.split('/') as [string, string];
  const repo = await client.getRepository(owner, name);
  const item = await client.getItem(owner, name, target.number);
  if (item.state !== 'open' || ('itemType' in target && target.itemType !== item.itemType))
    throw new Error(
      item.itemType === 'pull-request'
        ? 'launch-open-pull-request-required'
        : 'launch-open-issue-required',
    );
  const pullRequest = item.itemType === 'pull-request' ? manualPullRequest(repo, item) : undefined;
  if (pullRequest)
    for (const ref of [pullRequest.headRef, pullRequest.baseRef])
      await context.git(context.binding.workspace, ['check-ref-format', `refs/heads/${ref}`]);
  const canonical = `https://github.com/${repo.owner.login}/${repo.name}/${pullRequest ? 'pull' : 'issues'}/${item.number}`;
  if (
    item.number !== target.number ||
    `${repo.owner.login}/${repo.name}`.toLowerCase() !== target.repository.toLowerCase()
  )
    throw new Error('launch-target-identity-mismatch');
  const evidence = {
    ...dispatchContext(
      await client.getItemContext(repo.owner.login, repo.name, item.number, item.itemType, true),
      canonical,
      context.now,
    ),
    ...(pullRequest ? { pullRequest } : {}),
  };
  if (pullRequest && action.pullRequest) throw new Error('launch-pr-target-conflict');
  const connection = action.pullRequest
    ? await context.connectDelivery?.(context.binding.workspace)
    : undefined;
  if (
    action.pullRequest &&
    (!connection || connection.account.identity.nodeId !== client.identity.nodeId)
  )
    throw new Error('delivery-adoption-account-changed');
  const adopted = action.pullRequest
    ? await new IssueDeliveryProvider(connection!.account).adopt(
        {
          repositoryNodeId: repo.nodeId,
          item: {
            number: item.number,
            itemDatabaseId: item.databaseId,
            itemNodeId: item.nodeId,
            repositoryOwner: repo.owner.login,
            repositoryName: repo.name,
            repositoryDefaultBranch: repo.defaultBranch,
          },
        },
        action.pullRequest,
      )
    : undefined;
  if (adopted)
    for (const branch of [adopted.branch, adopted.base])
      await context.git(context.binding.workspace, ['check-ref-format', `refs/heads/${branch}`]);
  await context.assertCurrent();
  return journal.exclusive(async (state, save) => {
    const manual: OperatorIssue = {
      version: 1,
      id: automationHash([
        input.scope,
        client.identity.nodeId,
        repo.nodeId,
        item.nodeId,
        context.binding.session,
        context.inputId,
        ...(action.fresh ? ['fresh'] : []),
      ]),
      scope: input.scope,
      receiving: { login: client.identity.login, nodeId: client.identity.nodeId },
      workspaceDir: context.binding.workspace,
      agentId: context.binding.agentId,
      host: 'github.com',
      repository: {
        nodeId: repo.nodeId,
        databaseId: repo.databaseId,
        owner: { login: repo.owner.login, nodeId: repo.owner.nodeId },
        name: repo.name,
      },
      issue: { nodeId: item.nodeId, databaseId: item.databaseId, number: item.number },
      ...(pullRequest ? { pullRequest } : {}),
      initiation: {
        kind: 'operator',
        session: context.binding.session,
        incarnation: context.binding.incarnation,
        turn: context.turnId,
        input: context.inputId,
      },
      ...(action.fresh ? { fresh: true as const } : {}),
      selections: {
        ...(action.mode ? { mode: action.mode } : {}),
        ...action.stages,
        ...(action.routing ? { routing: action.routing } : {}),
      },
      evidence: {
        policyDigest: automationHash(context.manifest),
        mode:
          action.mode ?? context.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
        open: true,
        repositoryReadable: true,
      },
      observedAt: context.now,
      admittedAt: context.now,
      status: 'admitted',
      requiresRevalidation: true,
    };
    const key = issueKey(manual);
    const ownership = managedOwner(
      state.records,
      context.binding.session,
      (record) =>
        record.issueKey === key ||
        Boolean(
          pullRequest &&
          (record.delivery?.pullRequest?.pullRequestNodeId === item.nodeId ||
            record.work?.delivery?.pullRequest?.pullRequestNodeId === item.nodeId),
        ),
    );
    if (!action.fresh && !action.id && ownership.status === 'ambiguous')
      throw new Error('launch-owner-ambiguous');
    const own = ownership.caller;
    if (own && !own.retired && !own.reset && own !== ownership.owner)
      throw new Error('launch-managed-target-mismatch');
    let record = action.id
      ? state.records.find((entry) => entry.id === action.id && entry.issueKey === key)
      : action.fresh
        ? state.records.find((entry) => entry.id === manual.id && entry.manualIssue?.fresh)
        : ownership.owner;
    if (
      (!action.fresh && !action.id && ownership.status === 'historical') ||
      own?.retired ||
      own?.reset ||
      own?.supersededBy ||
      own?.retirement ||
      record?.retirement ||
      record?.retired ||
      record?.reset ||
      record?.supersededBy
    )
      throw new Error('launch-owner-inactive');
    if (action.id && record?.id !== action.id) throw new Error('launch-receipt-mismatch');
    if (record?.manualIssue?.pullRequest && pullRequest)
      manualPullRequest(repo, item, record.manualIssue.pullRequest);
    if (
      record?.manualIssue &&
      !record.request &&
      !record.threadId &&
      pullRequest &&
      record.manualIssue.pullRequest?.headSha !== pullRequest.headSha
    ) {
      record.manualIssue.pullRequest = pullRequest;
      record.context = JSON.stringify(evidence);
      await save();
    }

    if (
      adopted &&
      record &&
      automationHash(record.adoptedPullRequest) !== automationHash(adopted)
    ) {
      if (record.request || !record.adoptedPullRequest)
        throw new Error('launch-pr-binding-changed');
      record.adoptedPullRequest = adopted;
      if ('project' in record) delete record.project;
    }
    if (record?.threadId) {
      await input.verifyExisting(record);
      await context.assertCurrent();
      return {
        status: 'existing' as const,
        id: record.id,
        destination: record.threadId,
        sameConversation: record.threadId === context.binding.session,
        phase: record.phase,
        pending: !record.result && !record.handoff,
        instruction:
          'Reuse this managed issue destination and its current stage. Do not create another session or repeat completed setup. If creation or assessment dispatch is pending, call launch reconcile with this target/id from the original launching conversation.',
      };
    }
    if (
      !pullRequest &&
      issuePullRequestRecipients(context.manifest.github?.notifications, true)?.some(
        (entry) => 'source' in entry,
      )
    )
      throw new Error('launch-assignment-actor-recipient-unavailable');
    if (
      record?.manualIssue &&
      ((action.mode !== undefined && action.mode !== record.manualIssue.selections?.mode) ||
        (action.stages !== undefined &&
          automationHash(action.stages) !==
            automationHash({
              assessment: record.manualIssue.selections?.assessment,
              implementation: record.manualIssue.selections?.implementation,
            })) ||
        (action.routing !== undefined &&
          automationHash(action.routing) !==
            automationHash(record.manualIssue.selections?.routing ?? null)))
    )
      throw new Error('launch-selections-conflict');
    if (record && (!record.manualIssue || record.sourceThreadId !== context.binding.session))
      throw new Error('launch-preparation-owner-required');
    if (!record?.request) assertDispatchStorage(state, true);
    if (!record) {
      record = input.create({
        id: manual.id,
        manualIssue: manual,
        issueKey: key,
        sourceThreadId: context.binding.session,
        phase: 'routing',
        createdAt: context.now,
        manifestDigest: automationHash(context.manifest),
        context: JSON.stringify(evidence),
      });
      if (adopted) record.adoptedPullRequest = adopted;
      state.records.push(record);
    }
    const routing = record.request
      ? JSON.parse(record.routing!)
      : await initialModelRouting({
          models: context.manifest.models,
          manifestDigest: automationHash(context.manifest),
          request: { action: 'inspect' },
          runtime: context.binding.runtime,
          workspace: context.binding.workspace,
          observedAt: context.now,
          resolveSkill: context.resolveSkill,
        });
    if (!record.request && 'instructions' in routing)
      record.routingInstructions = routing.instructions;
    await context.assertCurrent();
    await save();
    return {
      status: 'routing-required' as const,
      id: record.id,
      context: JSON.parse(record.context!),
      digest: automationHash({
        context: record.context,
        ...(record.adoptedPullRequest ? { adoptedPullRequest: record.adoptedPullRequest } : {}),
        manifest: record.manifestDigest,
        instructions:
          record.routingInstructions && routingInstructionsDigest(record.routingInstructions),
      }),
      issue: canonical,
      routing,
      origin: record.manualIssue!.initiation,
      instruction:
        'Use the current model-routing profiles to assess this bounded issue, then call launch prepare with the same target/id, digest, assessment, and title. Preserve the original attempt on retry. ' +
        issueChatTitleGuidance,
    };
  }, true);
}
