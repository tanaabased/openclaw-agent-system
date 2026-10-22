import { lstat } from 'node:fs/promises';

import cleanupConfiguration from './cleanup-configuration.ts';
import reactivateAssignmentFeedback from './assignment-feedback-reactivation.ts';
import DiscoveryBudget from './discovery-budget.ts';

import type { DispatchAuthority, DispatchRequest } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import observeRetirementSession, { retirementObject } from './openclaw-retirement-observation.ts';
import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';

export default async function reconcileOpenClawLifecycle(input: {
  service: Pick<OpenClawDispatchContext, 'scope' | 'dependencies'>;
  manifest: AgentManifest;
  workspace: string;
  authority: DispatchAuthority;
  targetId?: string;
  activeSessionKey?: string;
}) {
  const { service, manifest, workspace, authority } = input;
  let cleanupManifest = manifest;
  const readConfiguration = () =>
    cleanupConfiguration(cleanupManifest, service.dependencies.readInstallationConfig);
  const configuration = await readConfiguration();
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
        (input.targetId === record.id || (record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now),
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
    cleanupManifest = loaded.manifest;
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
    const observed = await observeRetirementSession(request, record, manifest.agent.id, owner);
    return (
      observed && { ...observed, idle: observed.idle && record.threadId !== input.activeSessionKey }
    );
  };
  return current.journal.exclusive(async (state, save) => {
    const target = input.targetId && state.records.find((record) => record.id === input.targetId);
    if (input.targetId && (!target || target.retirement?.operatorRequest?.targetId !== target.id))
      throw new Error('dispatch-retire-target-mismatch');
    await reconcileAssignmentLifecycle({
      configuration,
      readConfiguration,
      records: state.records,
      admitted: current.admitted.records,
      policy: current.policy,
      client,
      owner,
      targetId: input.targetId,
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
    if (target)
      return {
        status: target.retired ? 'retired' : target.retirement ? 'retirement-pending' : 'active',
        id: target.id,
        retirement: target.retirement,
      };
  });
}
