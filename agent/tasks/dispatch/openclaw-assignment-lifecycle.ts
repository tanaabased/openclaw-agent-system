import { lstat } from 'node:fs/promises';
import type { DispatchAuthority, DispatchRequest } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import reactivateAssignmentFeedback from '../feedback/assignment-feedback-reactivation.ts';
import { listNativeAutomations } from '../../automations/automation-gateway.ts';
import { openClawCleanupConfiguration } from '../../cleanup-configuration.ts';
import DiscoveryBudget from '../../discovery-budget.ts';
import { managedPullRequest } from '../managed-issue.ts';
import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord, OpenClawDispatchState } from './openclaw-dispatch-state.ts';
import reconcileOpenClawRetirementEffects from '../retirement/openclaw-retirement-effects.ts';
import observeRetirementSession, {
  observeRetiringResource,
  retirementObject,
} from '../retirement/openclaw-retirement-observation.ts';
import pendingRetirement from '../retirement/pending-retirement.ts';
import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';
import replyOwnPublications from '../feedback/reply-own-publications.ts';
import retirementConsumption from '../retirement/retirement-consumption.ts';
import retirementEffects from '../retirement/retirement-effects.ts';
import retirementLocalData from '../retirement/retirement-local-data.ts';
import taskPullRequest from '../delivery/task-pull-request.ts';
import workflowFailure from '../workflow-failure.ts';
export default async function reconcileOpenClawLifecycle(input: {
  service: Pick<OpenClawDispatchContext, 'scope' | 'dependencies'>;
  manifest: AgentManifest;
  workspace: string;
  authority: DispatchAuthority;
  targetId?: string;
  activeSessionKey?: string;
  budget?: DiscoveryBudget;
}) {
  const { service, manifest, workspace, authority } = input;
  await reconcileOpenClawRetirementEffects({
    dependencies: service.dependencies,
    manifest,
    workspace,
    signal: authority.signal,
  });
  const readConfiguration = () => openClawCleanupConfiguration(service.dependencies.config);
  const configuration = await readConfiguration();
  const read = <T>(operation: string, run: () => Promise<T>) =>
    input.budget ? input.budget.read(operation, run) : run();
  const current = await read('lifecycle-scope', () => service.scope(manifest, workspace));
  current.policy.policy.issueAssignment!.allowed =
    manifest.github?.notifications?.issueAssignment?.allowed ?? [];
  const manualTarget =
    input.targetId &&
    (await current.journal.read()).records.find(
      (record) => record.id === input.targetId && record.manualIssue,
    );
  const owner = manualTarget
    ? manualTarget.sourceThreadId
    : await read('lifecycle-coordinator', () =>
        service.dependencies.coordinator(manifest, workspace),
      );
  const feedbackBudget = input.budget ?? new DiscoveryBudget();
  const now = (service.dependencies.now ?? Date.now)();
  const snapshot = await current.journal.read();
  if (
    !snapshot.records.some(
      (record) =>
        !record.reset &&
        (input.targetId === record.id || (record.lifecycleCheckedAt ?? -Infinity) + 60000 <= now),
    )
  )
    return;
  input.budget?.check();
  const client = await read('lifecycle-connection', () =>
    service.dependencies.connect(
      { manifest, workspaceDir: workspace },
      authority.signal ?? AbortSignal.timeout(20000),
    ),
  );
  const fresh = async () => {
    authority.signal?.throwIfAborted();
    await authority.assertCurrent?.();
    const loaded = await service.dependencies.taskContext.manifestService.loadForAgentId(
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
    if (observed && !observed.unavailableSession && !record.retirement)
      record.nativeInactive = observed.idle;
    return (
      observed && { ...observed, idle: observed.idle && record.threadId !== input.activeSessionKey }
    );
  };
  const reconcile = async (state: OpenClawDispatchState, save: () => Promise<void>) => {
    // older retirements retained patch failures before archive requests had their own receipt.
    const archiveHolds = new Map(
      state.records.flatMap((record) => {
        const retirement = record.retirement;
        const code = retirement?.code;
        return retirement &&
          !retirement.childArchiveRequests &&
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
      targetId: input.targetId,
      budget: input.budget,
      now,
      fresh,
      save,
      prepare: async (record, intake) => {
        await retirementConsumption(
          current.store,
          intake,
          record.id,
          now,
          record.retirement?.operatorRequest?.at ?? record.retirement?.at ?? now,
        );
        current.journal.retainRetirementEffects(state, retirementEffects(record, intake));
        pendingRetirement(record);
        await save();
      },
      dispose: async (record, intake) => {
        if (record.threadId && record.sessionCreation?.sessionId)
          await retirementLocalData({
            root: service.dependencies.root,
            binding: {
              runtime: 'openclaw',
              agentId: manifest.agent.id,
              workspace,
              namespace: service.dependencies.taskContext.namespace,
              session: record.threadId,
              incarnation: record.sessionCreation.sessionId,
            },
            intake,
            retain: async (effects) => {
              current.journal.retainRetirementEffects(state, effects);
              await save();
            },
          });
        await current.journal.dispose(state, record);
      },
      observe: (record) =>
        service.dependencies.credential.use(authority, (request) => observe(request, record)),
      reactivate: async (record, intake) => {
        const pr = taskPullRequest(record);
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
              authority.signal ?? AbortSignal.timeout(20000),
              client,
            );
            if (!provider) throw new Error('feedback-provider-unavailable');
            return provider;
          },
          announcement: record.announcement,
          ownReplies: async () => {
            const provider = await service.dependencies.feedbackConnect?.(
              { manifest, workspaceDir: workspace },
              authority.signal ?? AbortSignal.timeout(20000),
              client,
            );
            if (!provider) throw new Error('feedback-provider-unavailable');
            return replyOwnPublications({
              root: service.dependencies.root,
              binding: {
                runtime: 'openclaw',
                agentId: manifest.agent.id,
                workspace,
                namespace: service.dependencies.taskContext.namespace,
                session: record.threadId!,
                incarnation: record.sessionCreation!.sessionId!,
              },
              client: provider,
              replies: provider.replies,
            });
          },
          pullRequest: pr
            ? { number: pr.pullRequestNumber, nodeId: pr.pullRequestNodeId }
            : undefined,
        });
      },
      cleanup: async (record, intake, checkLifecycle, shared, _observed, issueClosed) => {
        const discard = issueClosed || Boolean(record.retirement?.operatorRequest);
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
            (!observed.idle && observed.unavailableSession !== 'not-found') ||
            (!discard && observed.row?.pinned === true) ||
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
                (!peer.idle && peer.unavailableSession !== 'not-found') ||
                (!discard && peer.row?.pinned === true) ||
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
            const nativeOwners = new Map<string, Record<string, unknown>>();
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
                nativeOwners.set(session.key, session);
              }
              if (nativeOwners.size === totalCount) {
                if (inventory.hasMore === true)
                  throw new Error('retirement-native-inventory-unresolved');
                break;
              }
              if (inventory.sessions.length !== 100 || nativeOwners.size > totalCount)
                throw new Error('retirement-native-inventory-unresolved');
            }
            const children = new Map<string, Record<string, unknown>>();
            const parents = new Set([record.threadId ?? record.request!.key]);
            if (discard) {
              // list can omit an intermediate helper; describe its exact native parent before classification.
              const inspected = new Set(nativeOwners.keys());
              for (const row of nativeOwners.values()) {
                const parent = row.parentSessionKey;
                if (
                  typeof parent !== 'string' ||
                  parents.has(parent) ||
                  inspected.has(parent) ||
                  !parent.startsWith(`agent:${manifest.agent.id}:subagent:`)
                )
                  continue;
                inspected.add(parent);
                const ancestor = retirementObject(
                  retirementObject(
                    await request('sessions.describe', { key: parent }),
                    'sessions-describe',
                  ).session,
                  'sessions-describe-session',
                );
                if (
                  ancestor.key !== parent ||
                  ancestor.agentId !== manifest.agent.id ||
                  (ancestor.spawnedCwd ?? ancestor.spawnedWorkspaceDir ?? ancestor.workspaceDir) !==
                    record.worktree
                )
                  throw new Error('retirement-session-identity-changed');
                nativeOwners.set(parent, ancestor);
              }
              let added = true;
              while (added) {
                added = false;
                for (const [key, row] of nativeOwners) {
                  if (
                    parents.has(key) ||
                    !key.startsWith(`agent:${manifest.agent.id}:subagent:`) ||
                    row.agentId !== manifest.agent.id ||
                    typeof row.sessionId !== 'string' ||
                    !row.sessionId ||
                    !parents.has(String(row.parentSessionKey))
                  )
                    continue;
                  children.set(key, row);
                  parents.add(key);
                  owners.add(key);
                  owners.add(`session:${key}`);
                  added = true;
                }
              }
            }
            for (const key of nativeOwners.keys())
              if (!owners.has(key)) throw new Error('retirement-worktree-shared');
            for (const [key, child] of children) {
              const live = await observeRetiringResource(request, {
                key,
                sessionId: String(child.sessionId),
                agentId: manifest.agent.id,
                cwd: record.worktree!,
              });
              if (!live.idle || live.row.parentSessionKey !== child.parentSessionKey)
                throw new Error('retirement-native-resource-protected');
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
            return children;
          };
          const recheck = async () => {
            await checkLifecycle();
            return custody();
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
            separateCheckout: Boolean(
              record.separateCheckout || record.manualIssue?.fresh || record.predecessorId,
            ),
            cloneUrl: repo.cloneUrl,
            defaultBranch: repo.defaultBranch,
            repositoryDatabaseId: repo.databaseId,
            itemDatabaseId: intake.issue.databaseId,
            itemNumber: intake.issue.number,
            itemType: managedPullRequest(intake) ? ('pull-request' as const) : ('issue' as const),
            ...(discard ? { closedIssueWorktree: record.worktree } : {}),
          };
          const worktree = await service.dependencies.worktrees.inspectGitHub(worktreeInput);
          if (worktree && worktree.path !== record.worktree)
            throw new Error('retirement-worktree-identity-changed');
          if (worktree) {
            const proof = await cleanup.call(service.dependencies.worktrees, {
              ...worktreeInput,
              worktree,
              verifyOnly: true,
              purge: discard,
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
          const children = await recheck();
          let childArchiveCode: string | undefined;
          for (const [key, child] of children) {
            const retirement = record.retirement!;
            const requests = (retirement.childArchiveRequests ??= {});
            const attempted = requests[key];
            if (attempted && attempted.sessionId !== child.sessionId)
              throw new Error('retirement-session-identity-changed');
            if (child.archived !== true && !child.archivedAt && !attempted) {
              requests[key] = { at: now, sessionId: String(child.sessionId) };
              await save();
              try {
                await request('sessions.patch', {
                  key,
                  expectedSessionId: child.sessionId,
                  ...(typeof child.lifecycleRevision === 'string'
                    ? { expectedLifecycleRevision: child.lifecycleRevision }
                    : {}),
                  archived: true,
                });
              } catch (error) {
                requests[key]!.code = workflowFailure(error, 'retirement-archive-unverified').code;
                await save();
              }
            }
            const row = retirementObject(
              retirementObject(await request('sessions.describe', { key }), 'sessions-describe')
                .session,
              'sessions-describe-session',
            );
            if (
              row.key !== key ||
              row.sessionId !== child.sessionId ||
              row.agentId !== manifest.agent.id ||
              row.parentSessionKey !== child.parentSessionKey ||
              (row.spawnedCwd ?? row.spawnedWorkspaceDir ?? row.workspaceDir) !== record.worktree
            )
              throw new Error('retirement-session-identity-changed');
            if (row.archived !== true && !row.archivedAt)
              childArchiveCode ??= requests[key]?.code ?? 'retirement-archive-unverified';
          }
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
            archived: archiveObserved && !childArchiveCode,
            ...(!observed.unavailableSession && !archiveObserved
              ? {
                  code: record.retirement!.archiveRequest?.code ?? 'retirement-archive-unverified',
                }
              : {}),
            ...(observed.unavailableSession
              ? { unavailableSession: observed.unavailableSession }
              : {}),
          };
          if (childArchiveCode)
            return { ...settled, code: childArchiveCode, worktreeRemoved: false };
          if (!archiveObserved && !observed.unavailableSession)
            return { ...settled, worktreeRemoved: false };
          for (const other of shared) {
            const peer = await observe(request, other);
            if (
              !peer ||
              (peer.unavailableSession !== 'not-found' && (!peer.archived || !peer.idle))
            )
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
                purge: discard,
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
        status: !state.records.some((record) => record.id === target.id)
          ? 'retired'
          : target.retirement
            ? 'retirement-pending'
            : 'active',
        id: target.id,
        retirement: target.retirement,
      };
  };
  return current.journal.exclusive(
    reconcile,
    true,
    'dispatch-reconcile',
    input.budget?.signal ?? authority.signal,
  );
}
