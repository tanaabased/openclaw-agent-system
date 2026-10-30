import { notificationAuthorityDigest } from './notification-authority.ts';
import { workflowFeedbackAvailable } from '../channels/github/feedback-policy.ts';
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { AutomationError } from './automation-gateway.ts';
import AutomationThreads, {
  AutomationThreadSettingsError,
  type AutomationThreadModelObservation,
  automationThreadSelection,
  type AutomationThreadAdapter,
} from './automation-threads.ts';
import { codexThreadAdapter, connectCodexThreads } from './codex-thread-client.ts';
import { codexIntakeJobs, intakeAutomationId } from './codex-intake-policy.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import {
  preflightCodexIntake,
  runCodexIntake,
  type CodexIntakeDependencies,
} from './codex-intake.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { automationHash } from './automation-hash.ts';
import planCodexAutomations, {
  automationRecordSchema,
  codexAutomationMarker,
  savedMatches,
  verifyThread,
  type CodexAutomationAction,
  type CodexAutomationInputs,
} from './codex-automation-plan.ts';
import {
  CodexAutomationError,
  nativeAutomationSchema,
  parseAutomationReceipt,
  readCodexAutomations,
  readCodexAutomationDefaults,
  type SavedAutomation,
} from './codex-automation-state.ts';
import { inspectCodexWorkspaceBinding } from './codex-workspace-binding.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import CodexSidebarJournal, { type SidebarEffect } from './codex-sidebar-journal.ts';
import { sidebarSections } from './codex-sidebar-placement.ts';

class SidebarPending extends AutomationError {
  constructor(readonly effect: Exclude<SidebarEffect, { status: 'done' }>) {
    super('automation-thread-group-drift');
  }
}

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const actionSchema = Type.Object(
  {
    manifestId: Type.String(),
    mode: Type.Union([Type.Literal('create'), Type.Literal('update')]),
    review: Type.Optional(Type.Boolean()),
    id: Type.Optional(Type.String()),
    expected: nativeAutomationSchema,
    removed: Type.Boolean(),
    retire: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: hash,
    records: Type.Array(automationRecordSchema),
    binding: Type.Optional(
      Type.Object(
        { workspace: Type.String(), codexHome: Type.String(), agentId: Type.String() },
        { additionalProperties: false },
      ),
    ),
    retired: Type.Optional(Type.Array(automationRecordSchema)),
    pending: Type.Optional(
      Type.Object(
        {
          digest: hash,
          manifestDigest: Type.String(),
          action: actionSchema,
          beforeHash: Type.Optional(hash),
          othersHash: Type.Optional(hash),
          targetBefore: Type.Optional(
            Type.Object(
              { hash, nativeIds: Type.Array(Type.String()) },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type Ledger = Static<typeof ledgerSchema>;
export interface CodexAutomationDependencies {
  codexHome?: string;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
  threadAdapter?: AutomationThreadAdapter;
  intake?: CodexIntakeDependencies;
}

async function snapshot(pluginData: string, dependencies: CodexAutomationDependencies) {
  const inspection = await (dependencies.inspectBinding ?? inspectCodexWorkspaceBinding)(
    pluginData,
  );
  const requestedHome = resolve(
    dependencies.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const codexHome = await realpath(requestedHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return requestedHome;
    throw error;
  });
  const root = resolve(pluginData);
  const ready =
    inspection.status === 'bound' &&
    inspection.preview.status === 'ready' &&
    inspection.preview.manifest.status === 'loaded';
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  if (names.length > 2000) throw new CodexAutomationError('automation-ownership-invalid');
  const retained: Ledger[] = [];
  for (const name of names.filter((name) => /^codex-automations-[a-f0-9]{64}\.json$/u.test(name))) {
    const stored = new PrivateStateFile({
      path: join(root, name),
      directories: [root],
      currentUid: process.getuid?.(),
      label: 'Codex automation ownership',
      maximumBytes: 1024 * 1024,
    });
    const value: unknown = JSON.parse((await stored.read()) ?? 'null');
    if (
      !Value.Check(ledgerSchema, value) ||
      name !== `codex-automations-${value.scope}.json` ||
      (value.binding &&
        value.scope !==
          automationHash({
            runtime: 'codex',
            profile: value.binding.codexHome,
            workspaceDir: value.binding.workspace,
            agentId: value.binding.agentId,
          }))
    )
      throw new CodexAutomationError('automation-ownership-invalid');
    if (
      value.binding?.codexHome === codexHome &&
      (value.records.some((record) => record.id === intakeAutomationId) ||
        value.pending?.action.manifestId === intakeAutomationId)
    )
      retained.push(value);
  }
  let cleanupOnly = !ready;
  let loaded: { digest: string; manifest: AgentManifest };
  let workspace: string;
  if (
    ready &&
    inspection.status === 'bound' &&
    inspection.preview.status === 'ready' &&
    inspection.preview.manifest.status === 'loaded'
  ) {
    loaded = inspection.preview.manifest;
    workspace = inspection.preview.workspaceDir;
    const prior = retained.filter(
      (entry) =>
        (entry.binding!.workspace !== workspace ||
          entry.binding!.agentId !== loaded.manifest.agent.id) &&
        (entry.pending ||
          entry.records.some((record) => record.id === intakeAutomationId && !record.removed)),
    );
    if (prior.length > 1) throw new CodexAutomationError('automation-ownership-conflict');
    if (prior[0]) {
      cleanupOnly = true;
      workspace = prior[0].binding!.workspace;
      loaded = {
        digest: 'cleanup-only',
        manifest: { schemaVersion: 1, agent: { id: prior[0].binding!.agentId } },
      };
    }
  } else {
    // cleanup uses verified private ownership even when desired policy cannot be parsed.
    const candidates = retained.filter(
      (entry) =>
        inspection.status !== 'bound' ||
        entry.binding!.workspace === inspection.binding.workspaceDir,
    );
    if (candidates.length !== 1) throw new CodexAutomationError('automation-binding-unavailable');
    const binding = candidates[0]!.binding!;
    workspace = binding.workspace;
    loaded = {
      digest: 'cleanup-only',
      manifest: { schemaVersion: 1, agent: { id: binding.agentId } },
    };
  }
  const scope = automationHash({
    runtime: 'codex',
    profile: codexHome,
    workspaceDir: workspace,
    agentId: loaded.manifest.agent.id,
  });
  const path = join(root, `codex-automations-${scope}.json`);
  const file = new PrivateStateFile({
    path,
    directories: [root],
    currentUid: process.getuid?.(),
    label: 'Codex automation ownership',
    maximumBytes: 1024 * 1024,
  });
  let ledger: Ledger;
  try {
    const contents = await file.read();
    const parsed: unknown =
      contents === undefined ? { version: 1, scope, records: [] } : JSON.parse(contents);
    if (!Value.Check(ledgerSchema, parsed) || parsed.scope !== scope)
      throw new Error('invalid ledger');
    ledger = parsed;
    if (ledger.pending && !ledger.pending.targetBefore && !ledger.pending.beforeHash)
      throw new Error('missing pending snapshot');
    for (const record of ledger.records) {
      if (!record.definition.prompt.endsWith(codexAutomationMarker(scope, record.id)))
        throw new Error('invalid marker');
    }
  } catch {
    throw new CodexAutomationError('automation-ownership-invalid');
  }
  let jobs: ResolvedAutomation[] = [];
  let policyBlocker: string | undefined;
  if (!cleanupOnly) {
    try {
      jobs = codexIntakeJobs(loaded.manifest, {
        entrypoint: resolve(process.argv[1]!),
        pluginData: root,
      });
    } catch (error) {
      cleanupOnly = true;
      policyBlocker =
        error instanceof IntakeError || error instanceof AutomationError
          ? error.code
          : 'intake-policy-invalid';
    }
  }
  return {
    loaded,
    workspace,
    codexHome,
    scope,
    file,
    ledger,
    root,
    path,
    dependencies,
    cleanupOnly,
    jobs,
    policyBlocker,
  };
}

async function resolveThreads(
  selected: Awaited<ReturnType<typeof snapshot>>,
  inputs: CodexAutomationInputs,
  apply = false,
) {
  const jobs = selected.jobs.filter(
    (job) => job.runtimes.includes('codex') && automationThreadSelection(job, 'codex'),
  );
  if (!jobs.length) return new Map<string, { id: string }>();
  const explicitIds = new Set<string>();
  for (const job of jobs) {
    const selection = automationThreadSelection(job, 'codex')!;
    if (!selection.managed) {
      try {
        await verifyThread(inputs.threads ?? [], selection.exact!, selected.workspace);
      } catch (error) {
        if (error instanceof CodexAutomationError) error.automationId = job.id;
        throw error;
      }
      explicitIds.add(selection.exact!);
    }
  }
  const sections = sidebarSections(inputs.nativeInventory);
  const journals = new Map<string, CodexSidebarJournal>();
  const destinations = new Map<string, string | undefined>();
  const pendingGroups = new Set<string>();
  for (const job of jobs) {
    const selection = automationThreadSelection(job, 'codex')!;
    const group = selection.group!;
    if (journals.has(group)) continue;
    const journal = new CodexSidebarJournal(selected.root, selected.codexHome, group);
    const { placement, state } = await journal.inspect(
      inputs.nativeInventory,
      selection.exact ?? 'pending',
      inputs.placementReceipt,
    );
    if (state.pending) pendingGroups.add(group);
    journals.set(group, journal);
    destinations.set(group, placement.sectionId);
  }
  let connection =
    selected.dependencies.threadAdapter ||
    jobs.every((job) => !automationThreadSelection(job, 'codex')!.managed)
      ? undefined
      : await connectCodexThreads(selected.workspace, selected.codexHome);
  try {
    const adapter =
      selected.dependencies.threadAdapter ??
      codexThreadAdapter(
        (method, params) => connection!.request(method, params),
        selected.workspace,
        async (id) => {
          await connection!.close();
          connection = await connectCodexThreads(selected.workspace, selected.codexHome);
          return connection.request('thread/resume', { threadId: id });
        },
        async (id) => {
          await connection!.close();
          connection = await connectCodexThreads(selected.workspace, selected.codexHome);
          return connection.request('thread/read', { threadId: id, includeTurns: false });
        },
      );
    const lookup = async (id: string, fresh = false) => {
      const native = explicitIds.has(id)
        ? { id }
        : await (fresh && adapter.lookupFresh ? adapter.lookupFresh(id) : adapter.lookup(id));
      if (!native) return native;
      const section = sections.find(
        (section) =>
          section.itemKeys.includes(`codex:thread:local:${id}`) &&
          destinations.get(section.name) === section.sectionId,
      );
      return {
        ...native,
        group: section && !pendingGroups.has(section.name) ? section.name : undefined,
      };
    };
    const bindings = await new AutomationThreads(
      { root: selected.root, scope: selected.scope, runtime: 'codex' },
      {
        ...adapter,
        lookup,
        lookupFresh: (id) => lookup(id, true),
        setGroup: async (id, group) => {
          const journal = journals.get(group)!;
          const state = await journal.read();
          const receipt =
            state.pending?.digest === inputs.placementReceipt?.digest
              ? inputs.placementReceipt
              : undefined;
          const effect = await journal.apply(selected.scope, inputs.nativeInventory, id, receipt);
          if (effect.status !== 'done') throw new SidebarPending(effect);
          pendingGroups.delete(group);
        },
      },
    ).resolve(jobs, apply);
    if (apply) {
      // retain the verified destination even when the chat was already correctly placed.
      for (const job of jobs) {
        const group = automationThreadSelection(job, 'codex')!.group!;
        const journal = journals.get(group)!;
        const state = await journal.read();
        if (state.sectionId === destinations.get(group) && !state.pending) continue;
        const effect = await journal.apply(
          selected.scope,
          inputs.nativeInventory,
          bindings.get(job.id)!.id,
        );
        if (effect.status !== 'done') throw new SidebarPending(effect);
      }
    }
    return bindings;
  } finally {
    await connection?.close();
  }
}

async function plan(selected: Awaited<ReturnType<typeof snapshot>>, inputs: CodexAutomationInputs) {
  const { loaded, workspace, scope, codexHome, ledger } = selected;
  const jobs = selected.jobs;
  const saved =
    jobs.some((job) => job.runtimes.includes('codex')) ||
    ledger.records.length ||
    ledger.retired?.length ||
    ledger.pending
      ? await readCodexAutomations(codexHome)
      : [];
  for (const retired of ledger.retired ?? []) {
    const actual = saved.find((item) => item.id === retired.nativeId);
    if (
      !actual ||
      retired.definition.status !== 'PAUSED' ||
      !savedMatches(actual, retired.definition, workspace)
    )
      throw new CodexAutomationError('automation-retired-job-diverged');
  }
  const needsDefaults = jobs.some(
    (job) =>
      job.runtimes.includes('codex') &&
      job.payload.kind === 'prompt' &&
      !automationThreadSelection(job, 'codex') &&
      (!job.overrides.codex?.model || !job.overrides.codex?.effort),
  );
  const defaults = needsDefaults
    ? await readCodexAutomationDefaults(codexHome).catch(() => undefined)
    : undefined;
  let bindings:
    Map<string, { id: string; settings?: AutomationThreadModelObservation }> | undefined;
  let threadSettings: AutomationThreadModelObservation | undefined;
  let threadCode: string | undefined;
  let threadAutomationId: string | undefined;
  try {
    bindings = await resolveThreads(selected, inputs);
  } catch (error) {
    if (error instanceof AutomationError || error instanceof CodexAutomationError)
      threadAutomationId = error.automationId;
    if (error instanceof AutomationThreadSettingsError) threadSettings = error.settings;
    threadCode =
      error instanceof AutomationError || error instanceof CodexAutomationError
        ? error.code
        : error instanceof Error && error.message.startsWith('automation-sidebar-')
          ? error.message
          : 'automation-thread-inspection-failed';
  }
  const result = await planCodexAutomations({
    scope,
    workspace,
    agentId: loaded.manifest.agent.id,
    manifestDigest: loaded.digest,
    jobs,
    saved: selected.cleanupOnly
      ? saved.filter((item) =>
          ledger.records.some(
            (record) => record.id === intakeAutomationId && record.nativeId === item.id,
          ),
        )
      : saved,
    records: selected.cleanupOnly
      ? ledger.records.filter((record) => record.id === intakeAutomationId)
      : ledger.records,
    inputs,
    defaults,
    bindings,
  });
  result.unmanagedCount = selected.cleanupOnly
    ? saved.length - ledger.records.filter((record) => record.id === intakeAutomationId).length
    : result.unmanagedCount - (ledger.retired?.length ?? 0);
  if (selected.policyBlocker) {
    result.findings.push({ id: intakeAutomationId, code: selected.policyBlocker });
    if (!result.actions.length) result.status = 'blocked';
  }
  if (threadCode) {
    result.findings.push({
      id: threadAutomationId ?? 'threads',
      code: threadCode,
      ...(threadSettings ? { settings: threadSettings } : {}),
    });
    result.actions = [];
    const synchronizable = new Set([
      'automation-thread-sync-required',
      'automation-thread-replacement-required',
      'automation-thread-name-drift',
      'automation-thread-model-drift',
      'automation-thread-settings-busy',
      'automation-thread-settings-unsupported',
      'automation-thread-group-drift',
      'automation-missing',
      'automation-drift',
      'automation-healthy',
      'automation-disabled',
      'automation-disabled-retained',
      'automation-removal-pending',
      'automation-target-migration-pending',
    ]);
    result.status = result.findings.every((finding) => synchronizable.has(finding.code))
      ? 'requires-native-app-sync'
      : 'blocked';
    result.digest = automationHash({
      plan: result.digest,
      threadCode,
      nativeInventory: inputs.nativeInventory,
    });
  }
  if (ledger.pending)
    return {
      saved,
      result: {
        ...result,
        status: 'blocked' as const,
        actions: [],
        findings: [
          ...result.findings,
          { id: ledger.pending.action.manifestId, code: 'automation-pending-readback-required' },
        ],
        pendingDigest: ledger.pending.digest,
      },
    };
  return { saved, result };
}

/** inspect desired and saved settings only; no locks, ledger writes, or scheduled execution. */
export async function inspectCodexAutomations(
  pluginData: string,
  inputs: CodexAutomationInputs = {},
  dependencies: CodexAutomationDependencies = {},
) {
  const selected = await snapshot(pluginData, dependencies);
  return (await plan(selected, inputs)).result;
}

/** new dispatch requires active consent; retained work may verify its owner after a pause. */
export async function inspectCodexDispatchActivation(
  pluginData: string,
  dependencies: CodexAutomationDependencies = {},
  pausedRecovery = false,
  retainedWork = false,
  capability:
    | 'intake'
    | 'assessment'
    | 'implementation'
    | 'review'
    | 'publication'
    | 'feedback'
    | 'assessment-summary' = 'assessment',
) {
  const selected = await snapshot(pluginData, dependencies);
  const job = selected.jobs.find((entry) => entry.id === intakeAutomationId);
  const record = selected.ledger.records.find((entry) => entry.id === intakeAutomationId);
  const activationCode =
    capability === 'intake'
      ? record
        ? 'intake-automation-update-required'
        : 'intake-activation-required'
      : 'dispatch-activation-required';
  if (!retainedWork && !pausedRecovery && job?.enabled === false)
    throw new CodexAutomationError('intake-automation-paused');
  const saved = await readCodexAutomations(selected.codexHome);
  const actual = saved.find((entry) => entry.id === record?.nativeId);
  if (!retainedWork && !pausedRecovery && actual?.definition.status === 'PAUSED')
    throw new CodexAutomationError('intake-automation-paused');
  const matchesPrompt = (prompt: string) => {
    const marker = '\n\n' + codexAutomationMarker(selected.scope, intakeAutomationId);
    return job?.payload.kind === 'prompt' && prompt === job.payload.prompt + marker;
  };
  if (
    (selected.cleanupOnly && (!retainedWork || !selected.policyBlocker)) ||
    (!retainedWork && selected.ledger.pending?.action.manifestId === intakeAutomationId) ||
    !record ||
    record.definition.kind !== 'heartbeat' ||
    (!retainedWork &&
      (!job ||
        job.payload.kind !== 'prompt' ||
        record.removed ||
        record.definition.status !== 'ACTIVE' ||
        !matchesPrompt(record.definition.prompt)))
  )
    throw new CodexAutomationError(activationCode);
  if (
    !retainedWork &&
    (!actual ||
      !savedMatches(
        actual,
        pausedRecovery ? { ...record.definition, status: 'PAUSED' } : record.definition,
        selected.workspace,
      ))
  )
    throw new CodexAutomationError(activationCode);
  if (capability === 'intake' || capability === 'assessment')
    return { sourceThreadId: record.definition.targetThreadId };
  // New workflows require current activation; retained tasks keep their recorded scope.
  if (
    capability === 'review' ||
    (!retainedWork &&
      (pausedRecovery ||
        !selected.loaded.manifest.github?.notifications ||
        (capability === 'feedback'
          ? !workflowFeedbackAvailable(
              selected.loaded.manifest.github.notifications,
              'issue-assignment',
            )
          : capability !== 'assessment-summary' &&
            !['work', 'auto'].includes(
              selected.loaded.manifest.github.notifications.issueAssignment?.mode ?? '',
            )) ||
        !job ||
        job.payload.kind !== 'prompt' ||
        record.removed ||
        record.definition.status !== 'ACTIVE' ||
        !matchesPrompt(record.definition.prompt)))
  )
    throw new Error('workflow-schedule-reconciliation-required');
  const authority = {
    workflow: 'issue-assignment' as const,
    automationId: record.nativeId,
    sourceThreadId: record.definition.targetThreadId,
    policyDigest: notificationAuthorityDigest(selected.loaded.manifest.github?.notifications),
    definitionDigest: automationHash(record.definition),
  };
  return {
    sourceThreadId: authority.sourceThreadId,
    schedule: {
      current: authority,
      saved: {
        ...authority,
        version: 1 as const,
        capabilities: (capability === 'assessment-summary'
          ? ['assessment-summary']
          : capability === 'feedback'
            ? ['feedback', 'publication']
            : ['assessment', 'implementation', 'publication']) as Array<
          'assessment' | 'implementation' | 'publication' | 'feedback' | 'assessment-summary'
        >,
      },
    },
  };
}

/** explicit native conversation sync; schedules remain owned by the desktop app tools. */
export async function syncCodexAutomationThreads(
  pluginData: string,
  digest: string,
  inputs: CodexAutomationInputs = {},
  dependencies: CodexAutomationDependencies = {},
) {
  const initial = await snapshot(pluginData, dependencies);
  return withJournal(initial, async () => {
    const selected = await snapshot(pluginData, dependencies);
    const { result } = await plan(selected, inputs);
    if (selected.scope !== initial.scope || selected.ledger.pending || result.digest !== digest)
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
    const allowed = new Set([
      'automation-thread-sync-required',
      'automation-thread-name-drift',
      'automation-thread-model-drift',
      'automation-thread-settings-busy',
      'automation-thread-settings-unsupported',
      'automation-thread-group-drift',
      'automation-thread-recovery-required',
      'automation-thread-replacement-required',
      'automation-healthy',
      'automation-disabled',
      'automation-disabled-retained',
      'automation-missing',
      'automation-drift',
      'automation-removal-pending',
      'automation-target-migration-pending',
    ]);
    if (result.findings.some((finding) => !allowed.has(finding.code)))
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
    const bindings = await resolveThreads(selected, inputs, true).catch((error) => {
      if (error instanceof SidebarPending) return error.effect;
      throw new CodexAutomationError(
        error instanceof AutomationError ? error.code : 'automation-thread-sync-failed',
      );
    });
    const current = await snapshot(pluginData, dependencies);
    if (current.loaded.digest !== selected.loaded.digest)
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
    if (!(bindings instanceof Map)) return bindings;
    return { status: 'verified', routing: 'per-automation', threads: Object.fromEntries(bindings) };
  });
}

/** operator inventory uses the same saved-state planner as doctor and install. */
export async function listCodexAutomations(
  pluginData: string,
  inputs: CodexAutomationInputs = {},
  dependencies: CodexAutomationDependencies = {},
) {
  const selected = await snapshot(pluginData, dependencies);
  const { saved, result } = await plan(selected, inputs);
  const jobs = selected.jobs;
  const ids = new Set([
    ...jobs.map(({ id }) => id),
    ...selected.ledger.records.map(({ id }) => id),
  ]);
  return {
    runtime: 'codex',
    workspaceDir: selected.workspace,
    ...result,
    jobs: [...ids].map((id) => {
      const declared = jobs.find((job) => job.id === id);
      const record = selected.ledger.records.find((entry) => entry.id === id);
      const actual = record ? saved.find((entry) => entry.id === record.nativeId) : undefined;
      return {
        id,
        declared: Boolean(declared),
        applicable: declared?.runtimes.includes('codex') ?? true,
        enabled: declared?.enabled ?? false,
        nativeId: record?.nativeId ?? null,
        nativeStatus: actual?.definition.status ?? null,
        removed: record?.removed ?? false,
        findings: result.findings.filter((finding) => finding.id === id),
      };
    }),
  };
}

/** reset may prepare native changes, but only the desktop tool can change a saved schedule. */
export async function codexNotificationResetAutomation(
  pluginData: string,
  dependencies: CodexAutomationDependencies = {},
) {
  const selected = await snapshot(pluginData, dependencies);
  if (selected.ledger.pending) throw new Error('notification-reset-automation-operation-pending');
  const record = selected.ledger.records.find(({ id }) => id === intakeAutomationId);
  if (!record?.nativeId || record.removed) throw new Error('notification-reset-automation-missing');
  const saved = (await readCodexAutomations(selected.codexHome)).find(
    ({ id }) => id === record.nativeId,
  );
  if (
    !saved ||
    !savedMatches(
      saved,
      { ...record.definition, status: saved.definition.status },
      selected.workspace,
    )
  )
    throw new Error('notification-reset-automation-changed');
  return saved;
}
/** reset owns paused schedule replacement after native archival; no unrelated jobs. */
export async function replaceCodexNotificationCoordinator(
  pluginData: string,
  before: SavedAutomation,
  dependencies: CodexAutomationDependencies = {},
  inputs: CodexAutomationInputs = {},
) {
  const initial = await snapshot(pluginData, dependencies);
  return withJournal(initial, async () => {
    const selected = await snapshot(pluginData, dependencies);
    if (selected.ledger.pending || selected.scope !== initial.scope)
      throw new Error('notification-reset-automation-operation-pending');
    if (before.definition.kind !== 'heartbeat')
      throw new Error('notification-reset-coordinator-missing');
    const record = selected.ledger.records.find(({ id }) => id === intakeAutomationId);
    const matches = pendingTargets(await readCodexAutomations(selected.codexHome), selected.scope, {
      manifestId: intakeAutomationId,
      mode: 'update',
      id: before.id,
      expected: before.definition,
      removed: false,
    });
    const actual = matches[0];
    if (
      !record ||
      record.removed ||
      matches.length > 1 ||
      (record.nativeId !== before.id && record.nativeId !== actual?.id) ||
      (actual &&
        (actual.definition.kind !== 'heartbeat' ||
          actual.definition.status !== 'PAUSED' ||
          !savedMatches(
            actual,
            {
              ...before.definition,
              targetThreadId: actual.definition.targetThreadId,
              status: 'PAUSED',
            },
            selected.workspace,
          )))
    )
      throw new Error('notification-reset-automation-changed');
    const jobs = selected.jobs.filter(({ id }) => id === intakeAutomationId);
    const bindings = await resolveThreads({ ...selected, jobs }, inputs, true).catch((error) => {
      if (error instanceof SidebarPending) return error.effect;
      throw error;
    });
    if (!(bindings instanceof Map)) return bindings;
    const target = bindings.get(intakeAutomationId)?.id;
    if (!target || target === before.definition.targetThreadId)
      throw new Error('notification-reset-coordinator-not-replaced');
    const definition = { ...before.definition, targetThreadId: target };
    // native chat archival can delete its heartbeat; the reset journal retains the create request.
    if (!actual)
      return {
        status: 'native-action' as const,
        request: {
          tool: 'automation_update',
          arguments: { ...definition, status: 'PAUSED', mode: 'create' },
        },
        instruction: 'create this paused schedule once, then repeat the same reset to verify it',
      };
    if (actual.definition.kind !== 'heartbeat')
      throw new Error('notification-reset-automation-changed');
    if (actual.definition.targetThreadId !== target) {
      if (
        actual.id !== before.id ||
        actual.definition.targetThreadId !== before.definition.targetThreadId
      )
        throw new Error('notification-reset-automation-changed');
      return {
        status: 'native-action' as const,
        request: {
          tool: 'automation_update',
          arguments: { ...definition, status: 'PAUSED', id: before.id, mode: 'update' },
        },
        instruction: 'retarget this paused schedule once, then repeat the same reset to verify it',
      };
    }
    record.nativeId = actual.id;
    record.definition = definition;
    await selected.file.write(JSON.stringify(selected.ledger));
    return {
      status: 'done' as const,
      automation: JSON.stringify({ ...before, id: actual.id, definition }),
    };
  });
}

/** no native occurrence or history API is available; never silently create a manual substitute. */
export async function codexAutomationRunGap(
  pluginData: string,
  id: string,
  action: 'run' | 'runs',
  dependencies: CodexAutomationDependencies = {},
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
    throw new CodexAutomationError('automation-id-invalid');
  const selected = await snapshot(pluginData, dependencies);
  const declared = selected.jobs.find((job) => job.id === id);
  const record = selected.ledger.records.find((entry) => entry.id === id);
  if (!declared && !(action === 'runs' && record))
    throw new CodexAutomationError('automation-id-missing');
  if (declared && !declared.runtimes.includes('codex'))
    throw new CodexAutomationError('automation-runtime-unsupported');
  return {
    runtime: 'codex',
    status: 'unsupported',
    id,
    nativeId: record?.nativeId ?? null,
    code: action === 'run' ? 'automation-run-now-unsupported' : 'automation-history-unavailable',
    telemetry: { execution: 'unavailable', delivery: 'unavailable' },
    ...(action === 'run'
      ? {
          manualTask: {
            requiresExplicitRequest: true,
            schedulerOccurrence: false,
            history: 'separate-task',
            consumesOneShot: false,
            guidance:
              'An explicitly requested manual task is separate from the saved scheduler job and does not prove scheduled execution.',
          },
        }
      : {}),
  };
}

/** serialize journal transitions across app-tool calls; a crash leaves an explicit recovery barrier. */
async function withJournal<T>(
  selected: Awaited<ReturnType<typeof snapshot>>,
  run: () => Promise<T>,
) {
  await ensurePrivateStateDirectories({
    directories: [selected.root],
    currentUid: process.getuid?.(),
    label: 'Codex automation ownership',
  });
  const lock = `${selected.path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new CodexAutomationError('automation-journal-busy');
  }
  try {
    return await run();
  } finally {
    await rmdir(lock);
  }
}

function pendingTargets(saved: SavedAutomation[], scope: string, action: CodexAutomationAction) {
  const marker = codexAutomationMarker(scope, action.manifestId);
  return saved.filter((item) => item.id === action.id || item.definition.prompt.includes(marker));
}

/** persist one exact next action before handing it to the native app. */
export async function prepareCodexAutomation(
  pluginData: string,
  digest: string,
  inputs: CodexAutomationInputs = {},
  dependencies: CodexAutomationDependencies = {},
) {
  const initial = await snapshot(pluginData, dependencies);
  return withJournal(initial, async () => {
    const selected = await snapshot(pluginData, dependencies);
    if (initial.scope !== selected.scope)
      throw new CodexAutomationError('automation-binding-changed');
    const { saved, result } = await plan(selected, inputs);
    if (
      result.status !== 'requires-native-app-sync' ||
      result.digest !== digest ||
      !result.actions[0]
    ) {
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
    }
    const action = result.actions[0];
    if (action.manifestId === intakeAutomationId && action.expected.status === 'ACTIVE') {
      const verified = await preflightCodexIntake(pluginData, {
        ...dependencies.intake,
        codexHome: selected.codexHome,
        inspectBinding: dependencies.inspectBinding,
      });
      const fresh = await snapshot(pluginData, dependencies);
      if (
        verified.manifestDigest !== selected.loaded.digest ||
        fresh.loaded.digest !== selected.loaded.digest ||
        fresh.scope !== selected.scope
      )
        throw new CodexAutomationError('automation-plan-stale-or-blocked');
    }
    const ledger: Ledger = {
      ...selected.ledger,
      binding: {
        workspace: selected.workspace,
        codexHome: selected.codexHome,
        agentId: selected.loaded.manifest.agent.id,
      },
      pending: {
        digest,
        manifestDigest: selected.loaded.digest,
        action,
        targetBefore: {
          hash: automationHash(pendingTargets(saved, selected.scope, action)),
          nativeIds: saved.map((item) => item.id),
        },
      },
    };
    await selected.file.write(JSON.stringify(ledger));
    return {
      status: 'prepared',
      digest,
      request: {
        mode: action.review ? `suggested_${action.mode}` : action.mode,
        ...(action.id ? { id: action.id } : {}),
        ...action.expected,
      },
    };
  });
}

/** acknowledge only exact saved state; missing receipts can recover solely from the pending marker. */
export async function acknowledgeCodexAutomation(
  pluginData: string,
  digest: string,
  receipt?: unknown,
  dependencies: CodexAutomationDependencies = {},
) {
  const initial = await snapshot(pluginData, dependencies);
  return withJournal(initial, async () => {
    const selected = await snapshot(pluginData, dependencies);
    const pending = selected.ledger.pending;
    if (selected.scope !== initial.scope || !pending || pending.digest !== digest)
      throw new CodexAutomationError('automation-pending-stale');
    const { action } = pending;
    const saved = await readCodexAutomations(selected.codexHome);
    const matches = pendingTargets(saved, selected.scope, action);
    const actual = matches.length === 1 ? matches[0] : undefined;
    const receiptId =
      receipt === undefined ? undefined : parseAutomationReceipt(receipt, action.mode);
    if (action.review && (!actual || automationHash(matches) === pending.targetBefore?.hash))
      throw new CodexAutomationError('automation-review-pending');
    if (
      !actual ||
      (action.id && actual.id !== action.id) ||
      (receiptId && receiptId !== actual.id) ||
      !savedMatches(actual, action.expected, selected.workspace)
    ) {
      throw new CodexAutomationError('automation-readback-diverged');
    }
    if (
      action.manifestId === intakeAutomationId &&
      action.expected.status === 'ACTIVE' &&
      !selected.cleanupOnly &&
      selected.loaded.digest === pending.manifestDigest &&
      selected.jobs.some((job) => job.id === intakeAutomationId)
    ) {
      const intake = await runCodexIntake(pluginData, true, {
        ...dependencies.intake,
        codexHome: selected.codexHome,
        inspectBinding: dependencies.inspectBinding,
      });
      if (intake.status !== 'ready') throw new CodexAutomationError('intake-activation-blocked');
    }
    const records = selected.ledger.records.filter((record) => record.id !== action.manifestId);
    const completed = {
      id: action.manifestId,
      nativeId: actual.id,
      definition: action.expected,
      removed: action.removed,
    };
    const retired = [...(selected.ledger.retired ?? [])];
    if (action.retire) retired.push(completed);
    else records.push(completed);
    await selected.file.write(
      JSON.stringify({
        version: 1,
        scope: selected.scope,
        binding: selected.ledger.binding,
        records,
        ...(retired.length ? { retired } : {}),
      }),
    );
    return { status: 'verified', manifestId: action.manifestId, nativeId: actual.id, digest };
  });
}

/** abandon a failed request only when its target is unchanged and no create is unaccounted for. */
export async function cancelCodexAutomation(
  pluginData: string,
  digest: string,
  dependencies: CodexAutomationDependencies = {},
) {
  const initial = await snapshot(pluginData, dependencies);
  return withJournal(initial, async () => {
    const selected = await snapshot(pluginData, dependencies);
    const pending = selected.ledger.pending;
    if (selected.scope !== initial.scope || !pending || pending.digest !== digest) {
      throw new CodexAutomationError('automation-cancel-recovery-required');
    }
    const saved = await readCodexAutomations(selected.codexHome);
    const before = pending.targetBefore;
    const unchanged = before
      ? automationHash(pendingTargets(saved, selected.scope, pending.action)) === before.hash &&
        (pending.action.mode !== 'create' ||
          saved.every((item) => before.nativeIds.includes(item.id)))
      : automationHash(saved) === pending.beforeHash;
    if (!unchanged) throw new CodexAutomationError('automation-cancel-recovery-required');
    await selected.file.write(JSON.stringify({ ...selected.ledger, pending: undefined }));
    return { status: 'cancelled', digest };
  });
}
