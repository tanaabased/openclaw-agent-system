import {
  inspectCodexIntakePermission,
  acknowledgeCodexIntakePermission,
  type IntakePermissionDependencies,
} from './codex-intake-permission.ts';
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { AutomationError } from './automation-gateway.ts';
import AutomationThreads, {
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

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const actionSchema = Type.Object(
  {
    manifestId: Type.String(),
    mode: Type.Union([Type.Literal('create'), Type.Literal('update')]),
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
  permission?: IntakePermissionDependencies;
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
      jobs = codexIntakeJobs(loaded.manifest);
    } catch (error) {
      cleanupOnly = true;
      policyBlocker = error instanceof IntakeError ? error.code : 'intake-policy-invalid';
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

async function resolveThreads(selected: Awaited<ReturnType<typeof snapshot>>, apply = false) {
  const jobs = selected.jobs.filter(
    (job) => job.runtimes.includes('codex') && automationThreadSelection(job, 'codex')?.managed,
  );
  if (!jobs.length) return new Map<string, { id: string }>();
  let connection = selected.dependencies.threadAdapter
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
          await connection.request('thread/resume', { threadId: id });
        },
      );
    return await new AutomationThreads(
      { root: selected.root, scope: selected.scope, runtime: 'codex' },
      adapter,
    ).resolve(jobs, apply);
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
  let bindings: Map<string, { id: string }> | undefined;
  let threadCode: string | undefined;
  try {
    bindings = await resolveThreads(selected);
  } catch (error) {
    threadCode =
      error instanceof AutomationError ? error.code : 'automation-thread-inspection-failed';
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
    result.findings.push({ id: 'threads', code: threadCode });
    result.actions = [];
    const synchronizable = new Set([
      'automation-thread-sync-required',
      'automation-thread-name-drift',
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
    result.digest = automationHash({ plan: result.digest, threadCode });
  }
  if (!selected.cleanupOnly && jobs.some((job) => job.id === intakeAutomationId)) {
    const permission = await inspectCodexIntakePermission(
      { pluginData: selected.root, workspace, codexHome },
      selected.dependencies.permission,
    );
    result.permission = permission;
    result.digest = automationHash({ plan: result.digest, permission });
    if (permission.code) {
      result.findings.push({ id: intakeAutomationId, code: permission.code });
      result.actions = result.actions.filter(
        (action) => action.manifestId !== intakeAutomationId || action.expected.status !== 'ACTIVE',
      );
      result.status = result.actions.length ? 'requires-native-app-sync' : 'blocked';
    }
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
      'automation-thread-recovery-required',
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
    const bindings = await resolveThreads(selected, true).catch((error) => {
      throw new CodexAutomationError(
        error instanceof AutomationError ? error.code : 'automation-thread-sync-failed',
      );
    });
    const current = await snapshot(pluginData, dependencies);
    if (current.loaded.digest !== selected.loaded.digest)
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
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
      request: { mode: action.mode, ...(action.id ? { id: action.id } : {}), ...action.expected },
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

/** Explicit operator acknowledgment after native recurring consent and reload; never grants permission. */
export async function codexIntakePermission(
  pluginData: string,
  input: unknown,
  dependencies: CodexAutomationDependencies = {},
) {
  const selected = await snapshot(pluginData, dependencies);
  if (selected.cleanupOnly || !selected.jobs.some((job) => job.id === intakeAutomationId))
    throw new CodexAutomationError('intake-policy-disabled');
  const context = {
    pluginData: selected.root,
    workspace: selected.workspace,
    codexHome: selected.codexHome,
  };
  if (input === undefined) return inspectCodexIntakePermission(context, dependencies.permission);
  return withJournal(selected, async () => {
    const fresh = await snapshot(pluginData, dependencies);
    if (
      fresh.scope !== selected.scope ||
      fresh.loaded.digest !== selected.loaded.digest ||
      fresh.ledger.pending
    )
      throw new CodexAutomationError('automation-plan-stale-or-blocked');
    return acknowledgeCodexIntakePermission(context, input, dependencies.permission);
  });
}
