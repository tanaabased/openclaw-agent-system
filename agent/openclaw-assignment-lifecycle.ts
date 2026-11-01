import { managedPullRequest } from './managed-issue.ts';
import { lstat } from 'node:fs/promises';

import { openClawCleanupConfiguration } from './cleanup-configuration.ts';
import reactivateAssignmentFeedback from './assignment-feedback-reactivation.ts';
import DiscoveryBudget from './discovery-budget.ts';
import { listNativeAutomations } from './automation-gateway.ts';
import workflowFailure from './workflow-failure.ts';

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
  const readConfiguration = () => openClawCleanupConfiguration(service.dependencies.config);
  const configuration = await readConfiguration();
  const current = await service.scope(manifest, workspace);
  current.policy.policy.issueAssignment!.allowed =
    manifest.github?.notifications?.issueAssignment?.allowed ?? [];
  const manualTarget =
    input.targetId &&
    (await current.journal.read()).records.find(
      (record) => record.id === input.targetId && record.manualIssue,
    );
  const owner = manualTarget
    ? manualTarget.sourceThreadId
    : await service.dependencies.coordinator(manifest, workspace);
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
    const selected = await service.scope(loaded.manifest, workspace);
    current.policy.policy = selected.policy.policy;
    current.policy.policy.issueAssignment!.allowed =
      loaded.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
    if (
      selected.workspace !== current.workspace ||
      (!manualTarget && (await service.dependencies.coordinator(manifest, workspace)) !== owner)
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
    // older retirements retained patch failures before archive requests had their own receipt.
    const archiveHolds = new Map(
      state.records.flatMap((record) => {
        const retirement = record.retirement;
        const code = retirement?.code;
        return retirement &&
          code &&
          (code.startsWith('session-dispatch-sessions-patch-') ||
            code === 'retirement-archive-unverified')
          ? [[record.id, { at: retirement.checkedAt, code }] as const]
          : [];
      }),
    );
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
      cleanup: async (record, intake, checkLifecycle, shared, _observed, issueClosed) => {
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
            (!issueClosed && observed.row?.pinned === true) ||
            observed.row?.key === owner
          )
            throw new Error('retirement-native-resource-protected');
          const held = archiveHolds.get(record.id);
          if (held && !record.retirement!.archiveRequest && observed.row) {
            record.retirement!.archiveRequest = {
              ...held,
              sessionId: String(observed.row.sessionId),
            };
            await save();
          }
          const custody = async () => {
            // this enrolled operator transport has no per-session list visibility filter.
            const before = retirementObject(await request('cron.status', {}), 'cron-status');
            const jobs = await listNativeAutomations(async (method, params) =>
              retirementObject(await request(method, params), 'cron-list'),
            );
            const after = retirementObject(await request('cron.status', {}), 'cron-status');
            if (
              !Number.isSafeInteger(before.jobs) ||
              before.jobs !== jobs.length ||
              after.jobs !== before.jobs
            )
              throw new Error('retirement-automation-ownership-unavailable');
            const custodians = state.records.filter(
              (entry) => entry.id !== record.id && entry.worktree === record.worktree,
            );
            for (const other of custodians) {
              const peer = await observe(request, other);
              if (
                !peer ||
                (!peer.idle && !peer.unavailableSession) ||
                (!issueClosed && peer.row?.pinned === true) ||
                peer.row?.key === owner
              )
                throw new Error('retirement-native-resource-protected');
            }
            const owners = new Set(
              [record, ...custodians].flatMap((entry) => {
                const key = entry.threadId ?? entry.request?.key;
                return key ? [key, `session:${key}`] : [];
              }),
            );
            let totalCount: number | undefined;
            const nativeOwners = new Set<string>();
            for (let offset = 0; ; offset += 100) {
              const inventory = retirementObject(
                await request('sessions.list', {
                  archived: 'all',
                  workspaceDir: record.worktree,
                  includeGlobal: true,
                  includeUnknown: true,
                  limit: 100,
                  offset,
                }),
                'sessions-list',
              );
              if (
                !Array.isArray(inventory.sessions) ||
                inventory.sessions.length > 100 ||
                !Number.isSafeInteger(inventory.totalCount) ||
                Number(inventory.totalCount) < 0 ||
                (totalCount !== undefined && inventory.totalCount !== totalCount)
              )
                throw new Error('retirement-native-inventory-unresolved');
              totalCount = Number(inventory.totalCount);
              for (const value of inventory.sessions) {
                const session = retirementObject(value, 'sessions-list-session');
                if (typeof session.key !== 'string' || nativeOwners.has(session.key))
                  throw new Error('retirement-native-inventory-unresolved');
                nativeOwners.add(session.key);
                if (!owners.has(session.key)) throw new Error('retirement-worktree-shared');
              }
              if (nativeOwners.size === totalCount) {
                if (inventory.hasMore === true)
                  throw new Error('retirement-native-inventory-unresolved');
                break;
              }
              if (inventory.sessions.length !== 100 || nativeOwners.size > totalCount)
                throw new Error('retirement-native-inventory-unresolved');
            }
            if (
              jobs.some(
                (job) =>
                  (job.enabled || job.state.runningAtMs !== undefined) &&
                  (owners.has(String(job.sessionTarget)) ||
                    owners.has(String(job.sessionKey)) ||
                    (job.payload.kind === 'command' && job.payload.cwd === record.worktree)),
              )
            )
              throw new Error('retirement-automation-owner');
          };
          const recheck = async () => {
            await checkLifecycle();
            await custody();
          };
          await custody();
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
            attemptId: record.worktreeAttemptId,
            separateCheckout: Boolean(record.manualIssue?.fresh || record.predecessorId),
            cloneUrl: repo.cloneUrl,
            defaultBranch: repo.defaultBranch,
            repositoryDatabaseId: repo.databaseId,
            itemDatabaseId: intake.issue.databaseId,
            itemNumber: intake.issue.number,
            itemType: managedPullRequest(intake) ? ('pull-request' as const) : ('issue' as const),
            ...(issueClosed ? { closedIssueWorktree: record.worktree } : {}),
          };
          const worktree = await service.dependencies.worktrees.inspectGitHub(worktreeInput);
          if (worktree && worktree.path !== record.worktree)
            throw new Error('retirement-worktree-identity-changed');
          if (worktree) {
            const proof = await cleanup.call(service.dependencies.worktrees, {
              ...worktreeInput,
              worktree,
              verifyOnly: true,
              purge: issueClosed,
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
          let archiveObserved = false;
          if (observed.unavailableSession) {
            record.retirement!.sessionUnavailableObserved = {
              at: now,
              session: observed.unavailableSession,
            };
          } else {
            const retirement = record.retirement!;
            if (
              retirement.archiveRequest &&
              retirement.archiveRequest.sessionId !== observed.row.sessionId
            )
              throw new Error('retirement-session-identity-changed');
            if (!observed.archived && !retirement.archiveRequest) {
              retirement.archiveRequest = { at: now, sessionId: String(observed.row.sessionId) };
              await save();
              try {
                await request('sessions.patch', {
                  key: observed.row.key,
                  expectedSessionId: observed.row.sessionId,
                  ...(typeof observed.row.lifecycleRevision === 'string'
                    ? { expectedLifecycleRevision: observed.row.lifecycleRevision }
                    : {}),
                  archived: true,
                });
              } catch (error) {
                retirement.archiveRequest.code = workflowFailure(
                  error,
                  'retirement-archive-unverified',
                ).code;
                await save();
              }
            }
            const archived = await observe(request, record);
            if (!archived?.idle) throw new Error('retirement-native-resource-protected');
            archiveObserved = archived.archived;
            if (archived.archived) retirement.archivedAt ??= now;
          }
          await save();
          const settled = {
            archived: archiveObserved,
            ...(!observed.unavailableSession && !archiveObserved
              ? { code: record.retirement!.archiveRequest?.code ?? 'retirement-archive-unverified' }
              : {}),
            ...(observed.unavailableSession
              ? { unavailableSession: observed.unavailableSession }
              : {}),
          };
          if (!issueClosed && !archiveObserved && !observed.unavailableSession)
            return { ...settled, worktreeRemoved: false };
          for (const other of issueClosed ? [] : shared) {
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
            if (record.retirement!.worktreeRemovalAttemptedAt)
              return {
                ...settled,
                worktreeRemoved: false,
                code:
                  record.retirement!.worktreeRemovalCode ??
                  'retirement-worktree-removal-unverified',
              };
            record.retirement!.worktreeRemovalAttemptedAt ??= now;
            await save();
            try {
              const result = await cleanup.call(service.dependencies.worktrees, {
                ...worktreeInput,
                worktree,
                purge: issueClosed,
              });
              if (result.status !== 'removed')
                throw new Error('retirement-worktree-' + result.status);
            } catch (error) {
              record.retirement!.worktreeRemovalCode = workflowFailure(
                error,
                'retirement-worktree-removal-unverified',
              ).code;
              await save();
              throw error;
            }
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
