import DiscoveryBudget from './discovery-budget.ts';
import reactivateAssignmentFeedback from './assignment-feedback-reactivation.ts';
import { lstat } from 'node:fs/promises';

import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type OpenClawDispatch from './openclaw-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { DispatchAuthority, DispatchRequest } from '../credentials/session-dispatch.ts';

/** observe the exact native session, including archived sessions and pending inputs. */
export async function observeRetiringSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
) {
  if (!record.request) return undefined;
  const expected = record.request;
  if (!('key' in expected) || !record.sessionCreation?.sessionId)
    throw new Error('retirement-session-identity-unresolved');
  const row = sessionObject(
    sessionObject(await request('sessions.describe', { key: expected.key })).session,
  );
  if (
    row.key !== expected.key ||
    row.agentId !== expected.agentId ||
    row.sessionId !== record.sessionCreation.sessionId ||
    (row.spawnedCwd ?? row.workspaceDir) !== record.worktree
  )
    throw new Error('retirement-session-identity-changed');
  const history = sessionObject(
    await request('chat.history', { sessionKey: expected.key, limit: 1 }),
  );
  if (history.sessionId !== row.sessionId || !Array.isArray(history.messages))
    throw new Error('retirement-session-history-unavailable');
  const info = sessionObject(history.sessionInfo);
  const pending = sessionObject(history.pendingInputs);
  const last = history.messages.at(-1);
  return {
    row,
    archived: row.archived === true || Boolean(row.archivedAt),
    idle: info.hasActiveRun === false && pending.total === 0,
    ...(typeof info.activeLeafEntryId === 'string'
      ? { activityId: info.activeLeafEntryId }
      : last && typeof sessionObject(last).id === 'string'
        ? { activityId: String(sessionObject(last).id) }
        : {}),
  };
}

export default async function reconcileOpenClawLifecycle(input: {
  service: OpenClawDispatch;
  manifest: AgentManifest;
  workspace: string;
  authority: DispatchAuthority;
}) {
  const { service, manifest, workspace, authority } = input;
  const current = await service.scope(manifest, workspace);
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
    const selected = await service.scope(manifest, workspace);
    if (
      selected.workspace !== current.workspace ||
      (await service.dependencies.coordinator(manifest, workspace)) !== owner
    )
      throw new Error('retirement-workflow-changed');
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
        service.dependencies.credential.use(authority, (request) =>
          observeRetiringSession(request, record),
        ),
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
          const observed = await observeRetiringSession(request, record);
          if (
            !observed ||
            !observed.idle ||
            observed.row.pinned === true ||
            record.threadId === owner
          )
            throw new Error('retirement-native-resource-protected');
          const jobs = sessionObject(await request('cron.list', { includeDisabled: true }));
          if (!Array.isArray(jobs.jobs))
            throw new Error('retirement-automation-ownership-unavailable');
          for (const other of shared) {
            const peer = await observeRetiringSession(request, other);
            if (!peer?.idle || peer.row.pinned === true || other.threadId === owner)
              throw new Error('retirement-native-resource-protected');
          }
          const owners = new Set(
            [record, ...shared].flatMap((entry) => [entry.threadId, `session:${entry.threadId}`]),
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
            // absence alone does not prove that the expected worktree was safely reclaimed.
            const absent =
              record.worktree &&
              (await lstat(record.worktree).then(
                () => false,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return true;
                  throw error;
                },
              ));
            if (!record.retirement?.worktreeRemovalAttemptedAt || !absent)
              throw new Error('retirement-worktree-observation-required');
            record.retirement.worktreeRemovedAt = now;
            await save();
          }
          await recheck();
          if (!observed.archived) {
            await request('sessions.patch', {
              key: record.threadId,
              expectedSessionId: record.sessionCreation!.sessionId,
              ...(typeof observed.row.lifecycleRevision === 'string'
                ? { expectedLifecycleRevision: observed.row.lifecycleRevision }
                : {}),
              archived: true,
            });
          }
          const archived = await observeRetiringSession(request, record);
          if (!archived?.archived || !archived.idle)
            throw new Error('retirement-archive-unverified');
          record.retirement!.archivedAt ??= now;
          await save();
          for (const other of shared) {
            const peer = await observeRetiringSession(request, other);
            if (!peer?.archived || !peer.idle)
              return {
                archived: true,
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
          return { archived: true, worktreeRemoved: true };
        });
      },
    });
  });
}
