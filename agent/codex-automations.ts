import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

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
  },
  { additionalProperties: false },
);
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: hash,
    records: Type.Array(automationRecordSchema),
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
}

async function snapshot(pluginData: string, dependencies: CodexAutomationDependencies) {
  const inspection = await (dependencies.inspectBinding ?? inspectCodexWorkspaceBinding)(
    pluginData,
  );
  if (
    inspection.status !== 'bound' ||
    inspection.preview.status !== 'ready' ||
    inspection.preview.manifest.status !== 'loaded'
  ) {
    throw new CodexAutomationError('automation-binding-unavailable');
  }
  const loaded = inspection.preview.manifest;
  const workspace = inspection.preview.workspaceDir;
  const requestedHome = resolve(
    dependencies.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const codexHome = await realpath(requestedHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return requestedHome;
    throw error;
  });
  const scope = automationHash({
    runtime: 'codex',
    profile: codexHome,
    workspaceDir: workspace,
    agentId: loaded.manifest.agent.id,
  });
  const root = resolve(pluginData);
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
  return { loaded, workspace, codexHome, scope, file, ledger, root, path };
}

async function plan(selected: Awaited<ReturnType<typeof snapshot>>, inputs: CodexAutomationInputs) {
  const { loaded, workspace, scope, codexHome, ledger } = selected;
  const jobs = loaded.manifest.automations ?? [];
  const saved =
    jobs.some((job) => job.runtimes.includes('codex')) || ledger.records.length || ledger.pending
      ? await readCodexAutomations(codexHome)
      : [];
  const needsDefaults = jobs.some(
    (job) =>
      job.runtimes.includes('codex') &&
      job.payload.kind === 'prompt' &&
      (job.overrides.codex?.target ?? 'independent') === 'independent' &&
      (!job.overrides.codex?.model || !job.overrides.codex?.effort),
  );
  const defaults = needsDefaults
    ? await readCodexAutomationDefaults(codexHome).catch(() => undefined)
    : undefined;
  const result = await planCodexAutomations({
    scope,
    workspace,
    agentId: loaded.manifest.agent.id,
    manifestDigest: loaded.digest,
    jobs,
    saved,
    records: ledger.records,
    inputs,
    defaults,
  });
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

/** operator inventory uses the same saved-state planner as doctor and install. */
export async function listCodexAutomations(
  pluginData: string,
  inputs: CodexAutomationInputs = {},
  dependencies: CodexAutomationDependencies = {},
) {
  const selected = await snapshot(pluginData, dependencies);
  const { saved, result } = await plan(selected, inputs);
  const jobs = selected.loaded.manifest.automations ?? [];
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
  const declared = selected.loaded.manifest.automations?.find((job) => job.id === id);
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
    const ledger: Ledger = {
      ...selected.ledger,
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
    const records = selected.ledger.records.filter((record) => record.id !== action.manifestId);
    records.push({
      id: action.manifestId,
      nativeId: actual.id,
      definition: action.expected,
      removed: action.removed,
    });
    await selected.file.write(JSON.stringify({ version: 1, scope: selected.scope, records }));
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
    await selected.file.write(
      JSON.stringify({ version: 1, scope: selected.scope, records: selected.ledger.records }),
    );
    return { status: 'cancelled', digest };
  });
}
