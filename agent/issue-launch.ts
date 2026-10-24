import resolveModelRoutingRequest from './model-routing-request.ts';
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
import type { OperatorIssue } from './managed-issue.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';

/** manual admission joins the existing dispatch journal; no assignment or scheduler effects. */
export default async function issueLaunch<R extends SharedDispatchRecord>(input: {
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
  if (currentTarget && target.url.toLowerCase() !== currentTarget.url.toLowerCase())
    throw new Error('launch-managed-target-mismatch');
  const [owner, name] = target.repository.split('/') as [string, string];
  const repo = await client.getRepository(owner, name);
  const item = await client.getItem(owner, name, target.number);
  if (item.itemType !== 'issue' || item.state !== 'open')
    throw new Error('launch-open-issue-required');
  const canonical = `https://github.com/${repo.owner.login}/${repo.name}/issues/${item.number}`;
  if (
    item.number !== target.number ||
    `${repo.owner.login}/${repo.name}`.toLowerCase() !== target.repository.toLowerCase()
  )
    throw new Error('launch-target-identity-mismatch');
  const evidence = dispatchContext(
    await client.getItemContext(repo.owner.login, repo.name, item.number, 'issue', true),
    canonical,
    context.now,
  );
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
      initiation: {
        kind: 'operator',
        session: context.binding.session,
        incarnation: context.binding.incarnation,
        turn: context.turnId,
        input: context.inputId,
      },
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
    const matches = state.records.filter((record) => record.issueKey === key);
    const own = state.records.find((record) => record.threadId === context.binding.session);
    if (own && own.issueKey !== key) throw new Error('launch-managed-target-mismatch');
    const active = matches.filter(
      (record) => !record.retired && !record.retirement && !record.reset && !record.nativeInactive,
    );
    if (active.length > 1) throw new Error('launch-owner-ambiguous');
    let record = active[0];
    if (!record && matches.length) throw new Error('launch-owner-inactive');
    if (action.id && record?.id !== action.id) throw new Error('launch-receipt-mismatch');
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
      state.records.push(record);
    }
    await context.assertCurrent();
    await save();
    return {
      status: 'routing-required' as const,
      id: record.id,
      context: JSON.parse(record.context!),
      digest: automationHash({ context: record.context, manifest: record.manifestDigest }),
      issue: canonical,
      routing: resolveModelRoutingRequest(
        context.manifest.models,
        record.manifestDigest,
        { action: 'inspect' },
        context.binding.runtime,
      ),
      origin: record.manualIssue!.initiation,
      instruction:
        'Use the current model-routing profiles to assess this bounded issue, then call launch prepare with the same target/id, digest, assessment, and a concise title. Preserve the original attempt on retry.',
    };
  }, true);
}
