import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { nativeObject } from './automation-gateway.ts';
import {
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
} from './command-authority.ts';
import { automationHash } from './automation-hash.ts';
import { selectCodexIntake, type CodexIntakeDependencies } from './codex-intake.ts';
import {
  codexNotificationResetAutomation,
  replaceCodexNotificationCoordinator,
} from './codex-automations.ts';
import { readCodexAutomations, type SavedAutomation } from './codex-automation-state.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import codexResetRemoved from './codex-reset-removed.ts';
import codexResetPlacement from './codex-reset-placement.ts';
import { connectCodexThreads, codexThreadAdapter } from './codex-thread-client.ts';
import codexRetirementNative from './codex-retirement-native.ts';
import waitForCodexWorktreeRemoval from './codex-worktree-removal.ts';
import NotificationResetStore, {
  type NotificationResetRecord,
} from './notification-reset-state.ts';
import { notificationResetResources, type ResetInventory } from './notification-reset-inventory.ts';
import resetNotifications, {
  previewNotificationReset,
  type NotificationResetAdapter,
} from './notification-reset.ts';

const schema = Type.Object(
  {
    agent: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    all: Type.Optional(Type.Boolean()),
    yes: Type.Optional(Type.Boolean()),
    purge: Type.Optional(Type.Boolean()),
    confirmation: Type.Optional(Type.String()),
    nativeInventory: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

interface Dependencies extends CodexIntakeDependencies {
  caller?: string;
  threads?: typeof connectCodexThreads;
  automation?: typeof codexNotificationResetAutomation;
  replaceCoordinator?: typeof replaceCodexNotificationCoordinator;
}

/** a bound Codex workspace has one agent; all means that binding, never other installations. */
export default async function runCodexNotificationReset(
  pluginData: string,
  input: unknown,
  deps: Dependencies = {},
) {
  if (
    process.env[agentCommandAuthorityEnvironmentName] ||
    process.env[agentCommandCapabilityEnvironmentName] ||
    (process.env.CODEX_THREAD_ID && process.env.OPENCLAW_STATE_DIR)
  )
    throw new Error('notification-reset-operator-required');
  if (!Value.Check(schema, input) || (input.all && input.agent?.length))
    throw new Error('notification-reset-options-invalid');
  if (!input.all && !input.agent?.length)
    throw new Error('notification-reset-explicit-bound-agent-required');
  const current = await selectCodexIntake(pluginData, deps, { inspectionOnly: true });
  if (!input.all && (input.agent?.length !== 1 || input.agent[0] !== current.agentId))
    throw new Error('notification-reset-explicit-bound-agent-required');
  const journal = new CodexDispatchStore(pluginData, current.store.location.scope);
  const store = new NotificationResetStore(pluginData, current.store.location.scope);
  const retained = await store.read();
  const parse = (record: NotificationResetRecord) =>
    JSON.parse(record.inventory) as Omit<ResetInventory, 'records'> & { records: DispatchRecord[] };
  const records = retained ? parse(retained).records : (await journal.read()).records;
  const caller = deps.caller ?? process.env.CODEX_THREAD_ID;
  if (
    caller &&
    records.some((record) =>
      [record.threadId, record.receiptThreadId, record.sourceThreadId].includes(caller),
    )
  )
    throw new Error('notification-reset-operator-required');
  const withNative = async <T>(
    run: (connection: Awaited<ReturnType<typeof connectCodexThreads>>) => Promise<T>,
  ) => {
    const connection = await (deps.threads ?? connectCodexThreads)(
      current.workspace,
      current.codexHome,
    );
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  };
  const observe = async (record: NotificationResetRecord) =>
    withNative(async ({ request }) => {
      const native = codexDispatchNative(request);
      const saved = JSON.parse(record.automation) as SavedAutomation;
      const sources = new Set(parse(record).records.map(({ sourceThreadId }) => sourceThreadId));
      if ('targetThreadId' in saved.definition) sources.add(saved.definition.targetThreadId);
      for (const threadId of sources) {
        if (!(await codexThreadAdapter(request, current.workspace).lookup(threadId))) continue;
        const { thread } = await request('thread/read', { threadId, includeTurns: false });
        if (!nativeObject(thread) || thread.id !== threadId || !nativeObject(thread.status))
          throw new Error('notification-reset-coordinator-observation-unavailable');
        if (!['idle', 'notLoaded'].includes(String(thread.status.type))) return false;
        const turns = await request('thread/turns/list', {
          threadId,
          itemsView: 'notLoaded',
          sortDirection: 'desc',
          limit: 1,
        });
        if (!Array.isArray(turns.data))
          throw new Error('notification-reset-coordinator-observation-unavailable');
        const last = turns.data[0];
        if (
          last &&
          (!nativeObject(last) ||
            !['completed', 'failed', 'interrupted'].includes(String(last.status)) ||
            typeof last.completedAt !== 'number' ||
            !Number.isFinite(last.completedAt) ||
            last.completedAt <= 0)
        )
          return false;
      }
      for (const entry of parse(record).records) {
        if (!entry.request) {
          if (entry.threadId) throw new Error('notification-reset-native-identity-unresolved');
          continue;
        }
        let thread;
        try {
          thread = await native.find({
            sourceThreadId: entry.sourceThreadId,
            prompt: entry.request.prompt,
            createdAfter: entry.createdAt,
            threadId: entry.threadId,
            observationOnly: true,
          });
        } catch (error) {
          if (await codexResetRemoved(request, entry, error)) continue;
          throw error;
        }
        if (!thread && (await codexResetRemoved(request, entry))) continue;
        if (!entry.threadId && !entry.worktree && !entry.receiptThreadId && !thread) continue;
        if (!entry.threadId || !entry.worktree)
          throw new Error('notification-reset-native-creation-unresolved');
        if (!thread || thread.cwd !== entry.worktree)
          throw new Error('notification-reset-native-identity-changed');
        if (!['idle', 'notLoaded'].includes(thread.status) || !thread.turnEnded) return false;
      }
      return true;
    });
  const automation = async () => {
    const saved = await (deps.automation ?? codexNotificationResetAutomation)(pluginData, deps);
    if (
      caller &&
      'targetThreadId' in saved.definition &&
      saved.definition.targetThreadId === caller
    )
      throw new Error('notification-reset-operator-required');
    return saved;
  };
  const toggle = async (record: NotificationResetRecord, restore: boolean) => {
    const before = JSON.parse(record.automation) as SavedAutomation;
    const actual = await automation();
    const withoutStatus = (job: SavedAutomation) => ({
      ...job,
      definition: { ...job.definition, status: 'PAUSED' },
    });
    if (automationHash(withoutStatus(actual)) !== automationHash(withoutStatus(before)))
      throw new Error('notification-reset-automation-changed');
    const status = restore ? before.definition.status : 'PAUSED';
    if (actual.definition.status === status) return { status: 'done' as const };
    return {
      status: 'native-action' as const,
      code: 'notification-reset-automation-action-required',
      request: {
        tool: 'automation_update',
        arguments: { ...actual.definition, id: actual.id, mode: 'update', status },
      },
      instruction:
        'execute this native update once, then rerun notifications reset with the same selection to verify saved state',
    };
  };
  const adapter: NotificationResetAdapter = {
    fence: (run) => current.store.exclusive(() => journal.exclusive(() => run(), true)),
    snapshot: async () => {
      const state = await current.store.read();
      if (!state) throw new Error('notification-reset-intake-missing');
      if (state.agentId !== current.agentId || state.workspaceDir !== current.workspace)
        throw new Error('notification-reset-scope-changed');
      const contents = { intake: state, records: (await journal.read()).records };
      const saved = await automation();
      if (saved.definition.kind !== 'heartbeat')
        throw new Error('notification-reset-coordinator-missing');
      return {
        runtime: 'codex',
        agentId: current.agentId,
        workspace: current.workspace,
        scope: current.store.location.scope,
        automation: JSON.stringify(saved),
        inventory: JSON.stringify(contents),
        resources: [
          {
            id: `coordinator:${saved.definition.targetThreadId}`,
            kind: 'coordinator',
            description: saved.definition.targetThreadId,
            identity: saved.id,
            details: [
              'archive the intake conversation and create a fresh coordinator; reconnect the paused schedule',
            ],
            state: 'pending',
          },
          ...(input.purge ? notificationResetResources(contents) : []),
        ],
      };
    },
    pause: (record) => toggle(record, false),
    idle: async (record) =>
      (await observe(record))
        ? { status: 'done' }
        : {
            status: 'waiting',
            code: 'notification-reset-turns-active',
            instruction:
              'wait for managed turns to finish, then repeat the same reset; do not abort turns automatically',
          },
    clear: async (record) => {
      await journal.reset(record.id);
    },
    baseline: async (record) => {
      await current.store.reset(record.baselineAt!);
    },
    coordinator: async (record) => {
      const before = JSON.parse(record.automation) as SavedAutomation;
      if (before.definition.kind !== 'heartbeat')
        throw new Error('notification-reset-coordinator-missing');
      const id = before.definition.targetThreadId;
      const archive = await withNative(async ({ request }) => {
        const thread = await codexThreadAdapter(request, current.workspace).lookup(id);
        if (!thread || thread.archived) return;
        if ((await automation()).definition.status !== 'PAUSED')
          throw new Error('notification-reset-pause-required');
        const ui = input.nativeInventory;
        if (
          !nativeObject(ui) ||
          ui.schemaVersion !== 4 ||
          !Array.isArray(ui.pinnedThreads) ||
          !Array.isArray(ui.unavailableHosts) ||
          ui.unavailableHosts.includes('local') ||
          !Array.isArray(ui.unavailableSources) ||
          ui.unavailableSources.includes('codex')
        )
          return {
            status: 'incomplete' as const,
            code: 'notification-reset-native-inventory-required',
            instruction:
              'read native list_threads and supply its complete result as nativeInventory when repeating this reset',
          };
        if (ui.pinnedThreads.some((row) => !nativeObject(row) || row.id === id))
          throw new Error('notification-reset-resource-protected');
        const jobs = await readCodexAutomations(current.codexHome);
        if (
          jobs.some(
            (job) =>
              job.id !== before.id &&
              'targetThreadId' in job.definition &&
              job.definition.targetThreadId === id,
          )
        )
          throw new Error('notification-reset-resource-protected');
        const { thread: observed } = await request('thread/read', {
          threadId: id,
          includeTurns: false,
        });
        if (
          !nativeObject(observed) ||
          !nativeObject(observed.status) ||
          !['idle', 'notLoaded'].includes(String(observed.status.type))
        )
          return { status: 'waiting' as const, code: 'notification-reset-turns-active' };
        return {
          status: 'native-action' as const,
          request: {
            tool: 'set_thread_archived',
            arguments: { threadId: id, archived: true, hostId: 'local' },
          },
          instruction:
            'archive this intake chat once, then repeat the same reset to verify and replace it',
        };
      });
      if (archive) return archive;
      const replacement = await (deps.replaceCoordinator ?? replaceCodexNotificationCoordinator)(
        pluginData,
        before,
        deps,
      );
      if (replacement.status !== 'done') return replacement;
      const saved = JSON.parse(replacement.automation) as SavedAutomation;
      if (saved.definition.kind !== 'heartbeat')
        throw new Error('notification-reset-coordinator-missing');
      const placement = codexResetPlacement(input.nativeInventory, saved.definition.targetThreadId);
      return placement.status === 'done' ? replacement : placement;
    },
    restore: (record) => toggle(record, true),
    purge: async (record, resource) => {
      const inventory = parse(record);
      const entry = inventory.records.find(({ id }) => id === resource.identity);
      if (!entry) throw new Error('notification-reset-resource-identity-missing');
      const item = inventory.intake.records.find(({ id }) => id === entry.intakeId);
      if (!item) throw new Error('notification-reset-intake-identity-missing');
      if (resource.kind === 'pull-request')
        throw new Error('notification-reset-remote-effect-forbidden');
      if (resource.kind === 'worktree') {
        if (await waitForCodexWorktreeRemoval(entry.worktree!)) return { status: 'done' };
        return {
          status: 'incomplete',
          code: 'notification-reset-native-worktree-removal-required',
          instruction:
            'the managed worktree remains after waiting 30 seconds for native cleanup; retry the same reset if cleanup is still running, or use native worktree controls in its owning Codex chat if it is stuck; its recovery inventory is retained',
        };
      }
      return withNative(async ({ request }) => {
        const native = codexDispatchNative(request);
        let thread;
        try {
          thread = await native.find({
            sourceThreadId: entry.sourceThreadId,
            prompt: entry.request!.prompt,
            createdAfter: entry.createdAt,
            threadId: entry.threadId,
            observationOnly: true,
          });
        } catch (error) {
          if (await codexResetRemoved(request, entry, error)) return { status: 'done' };
          throw error;
        }
        if (!thread && (await codexResetRemoved(request, entry))) return { status: 'done' };
        if (!thread) throw new Error('notification-reset-native-identity-changed');
        if (thread.archived) return { status: 'done' };
        if (!(await observe(record)))
          return { status: 'waiting', code: 'notification-reset-turns-active' };
        const ui = input.nativeInventory;
        if (
          !nativeObject(ui) ||
          ui.schemaVersion !== 4 ||
          !Array.isArray(ui.pinnedThreads) ||
          !Array.isArray(ui.unavailableHosts) ||
          ui.unavailableHosts.includes('local') ||
          !Array.isArray(ui.unavailableSources) ||
          ui.unavailableSources.includes('codex')
        )
          return {
            status: 'incomplete',
            code: 'notification-reset-native-inventory-required',
            instruction:
              'read native list_threads and supply its complete result as nativeInventory when repeating this reset',
          };
        if (ui.pinnedThreads.some((row) => !nativeObject(row) || row.id === entry.threadId))
          throw new Error('notification-reset-resource-protected');
        const jobs = await readCodexAutomations(current.codexHome);
        if (
          jobs.some(
            (job) =>
              ('targetThreadId' in job.definition &&
                job.definition.targetThreadId === entry.threadId) ||
              job.cwds?.includes(entry.worktree!),
          )
        )
          throw new Error('notification-reset-resource-protected');
        const owners = new Set(
          inventory.records
            .filter((row) => row.worktree === entry.worktree)
            .map((row) => row.threadId!),
        );
        if (
          (await codexRetirementNative(request).worktreeUsers(entry.worktree!, owners)).some(
            (id) => !owners.has(id),
          )
        )
          throw new Error('notification-reset-worktree-shared');
        return {
          status: 'native-action',
          request: {
            tool: 'set_thread_archived',
            arguments: { threadId: entry.threadId, archived: true, hostId: 'local' },
          },
          instruction: 'execute this native archive once, then rerun the same reset to verify it',
        };
      });
    },
  };
  const preview = await previewNotificationReset(store, adapter, input.purge === true);
  const confirmation = automationHash([preview.purge, preview.fingerprint]);
  if (input.confirmation && !preview.continuing && input.confirmation !== confirmation)
    throw new Error('notification-reset-preview-changed');
  if (!input.yes)
    return {
      status: 'confirmation-required',
      confirmation,
      agentId: preview.agentId,
      workspace: preview.workspace,
      purge: preview.purge,
      continuing: preview.continuing,
      resources: preview.resources,
      instruction:
        'confirm the selection, then repeat notifications reset with yes:true; intake pauses and managed turns must finish before reset',
    };
  return resetNotifications({ store, adapter, preview });
}
