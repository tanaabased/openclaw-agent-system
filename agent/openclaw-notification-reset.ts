import { lstat } from 'node:fs/promises';
import type { AgentManifest } from '../manifest/types.ts';
import type OpenClawIntake from './openclaw-intake.ts';
import type AutomationService from './automation-service.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type TrustedGitWorktreeService from '../tools/git/trusted-worktree-service.ts';
import type { ConnectedGitHubAccountClient } from '../core/github-account-client.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import closeResetPullRequest from '../channels/github/provider/reset-pull-request.ts';
import { listNativeAutomations, nativeObject } from './automation-gateway.ts';
import { openclawIntakeAutomationId } from './openclaw-intake-policy.ts';
import { observeRetiringSession } from './openclaw-assignment-lifecycle.ts';
import OpenClawDispatchStore, { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import NotificationResetStore, {
  type NotificationResetRecord,
} from './notification-reset-state.ts';
import resetNotifications, {
  previewNotificationReset,
  type NotificationResetAdapter,
  type NotificationResetPreview,
} from './notification-reset.ts';
import { notificationResetResources, type ResetInventory } from './notification-reset-inventory.ts';

interface Dependencies {
  root: string;
  intake: Pick<OpenClawIntake, 'select'>;
  automations: Pick<AutomationService, 'notificationResetSnapshot' | 'notificationResetToggle'>;
  credential: Pick<SessionDispatchCredential, 'use'>;
  worktrees: Pick<TrustedGitWorktreeService, 'inspectGitHub' | 'cleanupGitHub'>;
  connect(
    manifest: AgentManifest,
    workspace: string,
  ): Promise<{
    account: Pick<ConnectedGitHubAccountClient, 'identity' | 'execute'>;
    client: GitHubNotificationIntakeClient;
  }>;
}

/** the operator owns reset; scheduled and agent-bound dispatch never receive this adapter. */
export default class OpenClawNotificationReset {
  constructor(readonly dependencies: Dependencies) {}

  private async target(manifest: AgentManifest, workspaceDir: string, purge: boolean) {
    const deps = this.dependencies;
    const { store: intake, workspace } = await deps.intake.select(manifest, workspaceDir);
    const scope = intake.location.scope;
    const journal = new OpenClawDispatchStore(deps.root, scope);
    const store = new NotificationResetStore(deps.root, scope);
    const inventory = (record: NotificationResetRecord) =>
      JSON.parse(record.inventory) as Omit<ResetInventory, 'records'> & {
        records: OpenClawDispatchRecord[];
      };
    const observe = async (record: NotificationResetRecord, protect = false) => {
      const automation = JSON.parse(record.automation);
      const sources = new Set(
        inventory(record).records.map(({ sourceThreadId }) => sourceThreadId),
      );
      if (typeof automation.sessionKey === 'string') sources.add(automation.sessionKey);
      if (
        !sources.size &&
        !inventory(record).records.some((entry) => entry.threadId || entry.request)
      )
        return true;
      return deps.credential.use({}, async (request) => {
        for (const key of sources) {
          const response = await request('chat.history', { sessionKey: key, limit: 1 });
          if (
            !nativeObject(response) ||
            !nativeObject(response.sessionInfo) ||
            !nativeObject(response.pendingInputs)
          )
            throw new Error('notification-reset-coordinator-observation-unavailable');
          if (response.sessionInfo.hasActiveRun !== false || response.pendingInputs.total !== 0)
            return false;
        }
        const records = inventory(record).records;
        const jobs = protect
          ? await listNativeAutomations(async (method, params) => {
              const response = await request(method, params);
              if (!nativeObject(response))
                throw new Error('notification-reset-automation-inventory-unavailable');
              return response;
            })
          : undefined;
        const owners = new Set(records.map(({ sourceThreadId }) => sourceThreadId));
        for (const entry of records) {
          if (entry.request && !entry.threadId)
            throw new Error('notification-reset-session-creation-unresolved');
          if (!entry.threadId) continue;
          const current = await observeRetiringSession(request, entry);
          if (!current) throw new Error('notification-reset-session-unverified');
          if (!current.idle) return false;
          if (protect) {
            const owned = (value: unknown): boolean =>
              value === entry.threadId ||
              value === `session:${entry.threadId}` ||
              (Array.isArray(value)
                ? value.some(owned)
                : nativeObject(value) && Object.values(value).some(owned));
            if (current.row.pinned === true || owners.has(entry.threadId) || owned(jobs))
              throw new Error('notification-reset-resource-protected');
          }
        }
        return true;
      });
    };
    const adapter: NotificationResetAdapter = {
      fence: (run) => intake.exclusive(() => journal.exclusive(() => run(), true)),
      snapshot: async () => {
        const state = await intake.read();
        if (!state) throw new Error('notification-reset-intake-missing');
        if (state.agentId !== manifest.agent.id || state.workspaceDir !== workspace)
          throw new Error('notification-reset-scope-changed');
        const records = (await journal.read()).records;
        const contents = { intake: state, records };
        const resources = purge ? notificationResetResources(contents) : [];
        for (const resource of resources.filter(({ kind }) => kind === 'worktree')) {
          const entry = records.find(({ id }) => id === resource.identity)!;
          const item = state.records.find(({ id }) => id === entry.intakeId);
          if (!item) throw new Error('notification-reset-intake-identity-missing');
          const { client } = await deps.connect(manifest, workspace);
          const repository = await client.getRepository(
            item.repository.owner.login,
            item.repository.name,
          );
          if (
            repository.nodeId !== item.repository.nodeId ||
            repository.databaseId !== item.repository.databaseId
          )
            throw new Error('notification-reset-repository-changed');
          const observed = await deps.worktrees.inspectGitHub({
            agentId: manifest.agent.id,
            cloneUrl: repository.cloneUrl,
            defaultBranch: repository.defaultBranch,
            repositoryDatabaseId: repository.databaseId,
            itemDatabaseId: item.issue.databaseId,
            itemNumber: item.issue.number,
            itemType: 'issue',
          });
          if (observed && observed.path !== entry.worktree)
            throw new Error('notification-reset-worktree-changed');
          resource.custody = JSON.stringify(
            observed ? { path: observed.path, branch: observed.branch } : { missing: true },
          );
        }
        return {
          runtime: 'openclaw',
          agentId: manifest.agent.id,
          workspace,
          scope,
          automation: JSON.stringify(
            await deps.automations.notificationResetSnapshot(
              manifest,
              workspace,
              openclawIntakeAutomationId,
            ),
          ),
          inventory: JSON.stringify(contents),
          resources,
        };
      },
      pause: async (record) => {
        const expected = JSON.parse(record.automation);
        const observed = await deps.automations.notificationResetSnapshot(
          manifest,
          workspace,
          expected.id,
        );
        if (observed.hash !== expected.hash || observed.nativeId !== expected.nativeId)
          throw new Error('notification-reset-automation-changed');
        if (!observed.enabled) return { status: 'done' };
        if (!record.pauseAttempted) {
          try {
            await deps.automations.notificationResetToggle(manifest, workspace, expected, false);
            return { status: 'done' };
          } catch {
            /* observe a manual pause on later polls; do not repeat the failed write. */
          }
        }
        return {
          status: 'waiting',
          code: 'notification-reset-pause-required',
          instruction:
            'automatic pause could not be verified; pause the selected intake in the scheduler; waiting for it to stop accepting work',
        };
      },
      idle: async (record) =>
        (await observe(record))
          ? { status: 'done' }
          : {
              status: 'waiting',
              code: 'notification-reset-turns-active',
              instruction: 'waiting for managed turns to finish; no turns will be aborted',
            },
      clear: async (record) => {
        await journal.reset(record.id);
      },
      baseline: async (record) => {
        await intake.reset(record.baselineAt!);
      },
      restore: async (record) => {
        await deps.automations.notificationResetToggle(
          manifest,
          workspace,
          JSON.parse(record.automation),
          true,
        );
        return { status: 'done' };
      },
      purge: async (record, resource) => {
        if (!(await observe(record, true)))
          return { status: 'waiting', code: 'notification-reset-turns-active' };
        const retained = inventory(record);
        const entry = retained.records.find(({ id }) => id === resource.identity);
        if (!entry) throw new Error('notification-reset-resource-identity-missing');
        if (resource.kind === 'chat') {
          await deps.credential.use({}, async (request) => {
            const current = await observeRetiringSession(request, entry);
            if (!current?.idle) throw new Error('notification-reset-turns-active');
            if (!current.archived)
              await request('sessions.patch', {
                key: entry.threadId,
                expectedSessionId: current.row.sessionId,
                ...(typeof current.row.lifecycleRevision === 'string'
                  ? { expectedLifecycleRevision: current.row.lifecycleRevision }
                  : {}),
                archived: true,
              });
            const after = await observeRetiringSession(request, entry);
            if (!after?.archived || !after.idle)
              throw new Error('notification-reset-archive-unverified');
          });
          return { status: 'done' };
        }
        const item = retained.intake.records.find(({ id }) => id === entry.intakeId);
        if (!item) throw new Error('notification-reset-intake-identity-missing');
        const connected = await deps.connect(manifest, workspace);
        if (resource.kind === 'pull-request') {
          await closeResetPullRequest(connected.account, item, entry.work!.delivery!.pullRequest!);
          return { status: 'done' };
        }
        const repository = await connected.client.getRepository(
          item.repository.owner.login,
          item.repository.name,
        );
        if (
          repository.nodeId !== item.repository.nodeId ||
          repository.databaseId !== item.repository.databaseId
        )
          throw new Error('notification-reset-repository-changed');
        const input = {
          agentId: manifest.agent.id,
          cloneUrl: repository.cloneUrl,
          defaultBranch: repository.defaultBranch,
          itemDatabaseId: item.issue.databaseId,
          itemNumber: item.issue.number,
          itemType: 'issue' as const,
          repositoryDatabaseId: repository.databaseId,
        };
        const observed = await deps.worktrees.inspectGitHub(input);
        const absent = async () =>
          !(await lstat(entry.worktree!).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          }));
        if (!observed) {
          if (!(await absent()))
            throw new Error('notification-reset-worktree-ownership-unresolved');
          return { status: 'done' };
        }
        const custody = JSON.parse(resource.custody!);
        if (
          observed.path !== entry.worktree ||
          observed.path !== custody.path ||
          observed.branch !== custody.branch
        )
          throw new Error('notification-reset-worktree-changed');
        // protect any native conversation outside the retained management set.
        await deps.credential.use({}, async (request) => {
          for (let offset = 0; offset < 10000; offset += 100) {
            const result = await request('sessions.list', {
              archived: 'all',
              workspaceDir: entry.worktree,
              includeGlobal: true,
              includeUnknown: true,
              limit: 100,
              offset,
            });
            if (
              !nativeObject(result) ||
              !Array.isArray(result.sessions) ||
              result.sessions.some((row) => !nativeObject(row))
            )
              throw new Error('notification-reset-session-inventory-unavailable');
            if (
              result.sessions.some(
                (row) => !retained.records.some((other) => other.threadId === row.key),
              )
            )
              throw new Error('notification-reset-worktree-shared');
            if (result.sessions.length < 100) return;
          }
          throw new Error('notification-reset-session-inventory-incomplete');
        });
        const result = await deps.worktrees.cleanupGitHub({
          ...input,
          worktree: { path: observed.path, branch: observed.branch },
          purge: true,
        });
        if (!['removed', 'missing'].includes(result.status))
          throw new Error(`notification-reset-worktree-${result.status}`);
        if (!(await absent())) throw new Error('notification-reset-worktree-removal-unverified');
        return { status: 'done' };
      },
    };
    return { store, adapter };
  }
  async preview(manifest: AgentManifest, workspace: string, purge: boolean) {
    const { store, adapter } = await this.target(manifest, workspace, purge);
    return previewNotificationReset(store, adapter, purge);
  }
  async run(manifest: AgentManifest, workspace: string, preview: NotificationResetPreview) {
    const { store, adapter } = await this.target(manifest, workspace, preview.purge);
    return resetNotifications({ store, adapter, preview });
  }
}
