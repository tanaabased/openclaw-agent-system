import { lstat } from 'node:fs/promises';
import reactivateAssignmentFeedback from './assignment-feedback-reactivation.ts';
import DiscoveryBudget from './discovery-budget.ts';

import type { DispatchAuthority, DispatchRequest } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import observeUnavailableRetirementSession from './openclaw-retirement-unavailable.ts';
import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';
import workflowFailure from './workflow-failure.ts';

function retirementObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const type =
      value === null
        ? 'null'
        : value === undefined
          ? 'missing'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
    throw new Error('dispatch-session-response-invalid-' + field + '-' + type);
  }
  return value as Record<string, unknown>;
}

/** observe the exact native session, including archived sessions and pending inputs. */
export async function observeRetiringSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  agentId: string,
) {
  if (!record.request) return undefined;
  const intent = record.request;
  const expected =
    'key' in intent
      ? { key: intent.key, sessionId: record.sessionCreation?.sessionId }
      : record.native;
  if (
    !expected?.sessionId ||
    !('key' in intent
      ? record.sessionCreation?.attempted && intent.agentId === agentId
      : record.creationCall &&
        record.creationCall.sessionId === record.native?.sourceSessionId &&
        record.creationCall.toolCallId === record.native?.toolCallId) ||
    (record.threadId &&
      record.threadId !== ('key' in expected ? expected.key : expected.sessionKey)) ||
    record.worktree !== intent.cwd
  )
    throw new Error('retirement-session-identity-unresolved');
  const key = 'key' in expected ? expected.key : expected.sessionKey;
  const row = retirementObject(
    retirementObject(await request('sessions.describe', { key }), 'sessions-describe').session,
    'sessions-describe-session',
  );
  if (
    row.key !== key ||
    row.agentId !== agentId ||
    row.sessionId !== expected.sessionId ||
    (row.spawnedCwd ?? row.workspaceDir) !== record.worktree
  )
    throw new Error('retirement-session-identity-changed');
  const history = retirementObject(
    await request('chat.history', { sessionKey: key, limit: 1 }),
    'chat-history',
  );
  if (history.sessionId !== row.sessionId || !Array.isArray(history.messages))
    throw new Error('retirement-session-history-unavailable');
  const info = retirementObject(history.sessionInfo, 'chat-history-session-info');
  const pending = retirementObject(history.pendingInputs, 'chat-history-pending-inputs');
  const last = history.messages.at(-1);
  return {
    row,
    archived: row.archived === true || Boolean(row.archivedAt),
    idle: info.hasActiveRun === false && pending.total === 0,
    ...(typeof info.activeLeafEntryId === 'string'
      ? { activityId: info.activeLeafEntryId }
      : last && typeof retirementObject(last, 'chat-history-last-message').id === 'string'
        ? { activityId: String(retirementObject(last, 'chat-history-last-message').id) }
        : {}),
  };
}

export default async function reconcileOpenClawLifecycle(input: {
  service: Pick<OpenClawDispatchContext, 'scope' | 'dependencies'>;
  manifest: AgentManifest;
  workspace: string;
  authority: DispatchAuthority;
}) {
  const { service, manifest, workspace, authority } = input;
  const current = await service.scope(manifest, workspace);
  current.policy.policy.issueAssignment!.allowed =
    manifest.github?.notifications?.issueAssignment?.allowed ?? [];
  const owner = await service.dependencies.coordinator(manifest, workspace);
  const feedbackBudget = new DiscoveryBudget();
  const now = (service.dependencies.now ?? Date.now)();
  const snapshot = await current.journal.read();
  if (
    !snapshot.records.some(
      (record) =>
        !record.retired &&
        !record.reset &&
        (record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now,
    )
  )
    return;
  const client = await service.dependencies.connect(
    { manifest, workspaceDir: workspace },
    authority.signal ?? AbortSignal.timeout(20_000),
  );
  const fresh = async () => {
    authority.signal?.throwIfAborted();
    await authority.assertCurrent?.();
    const loaded = await service.dependencies.intake.dependencies.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (loaded.status !== 'loaded' || loaded.scope.workspaceDir !== workspace)
      throw new Error('retirement-workflow-changed');
    const selected = await service.scope(loaded.manifest, workspace);
    current.policy.policy = selected.policy.policy;
    current.policy.policy.issueAssignment!.allowed =
      loaded.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
    if (
      selected.workspace !== current.workspace ||
      (await service.dependencies.coordinator(manifest, workspace)) !== owner
    )
      throw new Error('retirement-workflow-changed');
  };
  const observe = async (request: DispatchRequest, record: OpenClawDispatchRecord) => {
    try {
      const observed = await observeRetiringSession(request, record, manifest.agent.id);
      return observed && { ...observed, unavailableSession: undefined };
    } catch (error) {
      const unavailableSession = await observeUnavailableRetirementSession({
        record,
        agentId: manifest.agent.id,
        owner,
        request,
        code: workflowFailure(error, 'retirement-native-observation-unavailable').code,
      });
      if (!unavailableSession) throw error;
      return { row: undefined, archived: false, idle: false, unavailableSession };
    }
  };
  return current.journal.exclusive(async (state, save) => {
    await reconcileAssignmentLifecycle({
      records: state.records,
      admitted: current.admitted.records,
      policy: current.policy,
      client,
      owner,
      now,
      fresh,
      save,
      observe: (record) =>
        service.dependencies.credential.use(authority, (request) => observe(request, record)),
      reactivate: async (record, intake) => {
        const pr = record.work?.delivery?.reconciled ? record.work.delivery.pullRequest : undefined;
        return reactivateAssignmentFeedback({
          record,
          intake,
          policy: current.policy,
          client,
          now,
          save,
          budget: feedbackBudget,
          comments: async () => {
            const provider = await service.dependencies.feedbackConnect?.(
              { manifest, workspaceDir: workspace },
              authority.signal ?? AbortSignal.timeout(20_000),
              client,
            );
            if (!provider) throw new Error('feedback-provider-unavailable');
            return provider;
          },
          announcement: record.work?.delivery?.announcement,
          pullRequest: pr
            ? { number: pr.pullRequestNumber, nodeId: pr.pullRequestNodeId }
            : undefined,
        });
      },
      cleanup: async (record, intake, recheck, shared) => {
        if (!record.request) return { archived: true, worktreeRemoved: true };
        const cleanup = service.dependencies.worktrees.cleanupGitHub;
        if (!cleanup)
          return {
            archived: false,
            worktreeRemoved: false,
            code: 'retirement-worktree-cleanup-unavailable',
          };
        return service.dependencies.credential.use(authority, async (request) => {
          const observed = await observe(request, record);
          if (
            !observed ||
            (!observed.idle && !observed.unavailableSession) ||
            observed.row?.pinned === true ||
            observed.row?.key === owner
          )
            throw new Error('retirement-native-resource-protected');
          const jobs = retirementObject(
            await request('cron.list', { includeDisabled: true }),
            'cron-list',
          );
          if (!Array.isArray(jobs.jobs))
            throw new Error('retirement-automation-ownership-unavailable');
          for (const other of shared) {
            const peer = await observe(request, other);
            if (
              !peer ||
              (!peer.idle && !peer.unavailableSession) ||
              peer.row?.pinned === true ||
              peer.row?.key === owner
            )
              throw new Error('retirement-native-resource-protected');
          }
          const owners = new Set(
            [record, ...shared].flatMap((entry) => {
              const key =
                entry.request && 'key' in entry.request
                  ? entry.request.key
                  : entry.native?.sessionKey;
              return key ? [key, `session:${key}`] : [];
            }),
          );
          const owns = (value: unknown): boolean =>
            (typeof value === 'string' && owners.has(value)) ||
            (Array.isArray(value)
              ? value.some(owns)
              : !!value && typeof value === 'object' && Object.values(value).some(owns));
          if (jobs.jobs.some(owns)) throw new Error('retirement-automation-owner');
          const repo = await client.getRepository(
            intake.repository.owner.login,
            intake.repository.name,
          );
          if (
            repo.nodeId !== intake.repository.nodeId ||
            repo.databaseId !== intake.repository.databaseId
          )
            throw new Error('retirement-repository-identity-changed');
          const worktreeInput = {
            agentId: manifest.agent.id,
            cloneUrl: repo.cloneUrl,
            defaultBranch: repo.defaultBranch,
            repositoryDatabaseId: repo.databaseId,
            itemDatabaseId: intake.issue.databaseId,
            itemNumber: intake.issue.number,
            itemType: 'issue' as const,
          };
          const worktree = await service.dependencies.worktrees.inspectGitHub(worktreeInput);
          if (worktree && worktree.path !== record.worktree)
            throw new Error('retirement-worktree-identity-changed');
          if (worktree) {
            const proof = await cleanup.call(service.dependencies.worktrees, {
              ...worktreeInput,
              worktree,
              verifyOnly: true,
            });
            if (proof.status !== 'preserved')
              throw new Error('retirement-worktree-' + proof.status);
          } else if (!record.retirement?.worktreeRemovedAt) {
            // native custody and managed inventory are checked before observing external removal.
            const absent =
              record.worktree &&
              (await lstat(record.worktree).then(
                () => false,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return true;
                  throw error;
                },
              ));
            if (!absent) throw new Error('retirement-worktree-observation-required');
            await recheck();
            record.retirement!.worktreeRemovalObserved = {
              at: now,
              source: record.retirement!.worktreeRemovalAttemptedAt
                ? 'retirement-attempt'
                : 'external-cleanup',
            };
            record.retirement!.worktreeRemovedAt = now;
            await save();
          }
          await recheck();
          if (observed.unavailableSession) {
            record.retirement!.sessionUnavailableObserved = {
              at: now,
              session: observed.unavailableSession,
            };
          } else {
            if (!observed.archived) {
              await request('sessions.patch', {
                key: observed.row.key,
                expectedSessionId: observed.row.sessionId,
                ...(typeof observed.row.lifecycleRevision === 'string'
                  ? { expectedLifecycleRevision: observed.row.lifecycleRevision }
                  : {}),
                archived: true,
              });
            }
            const archived = await observe(request, record);
            if (!archived?.archived || !archived.idle)
              throw new Error('retirement-archive-unverified');
            record.retirement!.archivedAt ??= now;
          }
          await save();
          const settled = {
            archived: !observed.unavailableSession,
            ...(observed.unavailableSession
              ? { unavailableSession: observed.unavailableSession }
              : {}),
          };
          for (const other of shared) {
            const peer = await observe(request, other);
            if (!peer || (!peer.unavailableSession && (!peer.archived || !peer.idle)))
              return {
                ...settled,
                worktreeRemoved: false,
                code: 'retirement-shared-archive-pending',
              };
          }
          if (worktree) {
            await recheck();
            record.retirement!.worktreeRemovalAttemptedAt ??= now;
            await save();
            const result = await cleanup.call(service.dependencies.worktrees, {
              ...worktreeInput,
              worktree,
            });
            if (result.status !== 'removed')
              throw new Error('retirement-worktree-' + result.status);
            record.retirement!.worktreeRemovedAt = now;
            await save();
          }
          return { ...settled, worktreeRemoved: true };
        });
      },
    });
  });
}
