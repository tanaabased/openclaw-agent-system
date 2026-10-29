import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { AutomationError } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import type { AutomationRuntime, ResolvedAutomation } from '../manifest/automation-schema.ts';
import managedGroupName, { defaultManagedGroup } from '../utils/managed-group-name.ts';

const settingsSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    effort: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const settingsUpdateSchema = Type.Object(
  {
    nativeId: Type.String(),
    incarnation: Type.Optional(Type.String()),
    desired: settingsSchema,
    baseline: settingsSchema,
    phase: Type.Union([
      Type.Literal('uncertain'),
      Type.Literal('denied'),
      Type.Literal('busy'),
      Type.Literal('unsupported'),
    ]),
  },
  { additionalProperties: false },
);

const recordSchema = Type.Object(
  {
    key: Type.String(),
    settingsUpdate: Type.Optional(settingsUpdateSchema),
    generation: Type.Optional(Type.String()),
    retiredId: Type.Optional(Type.String()),
    nativeId: Type.Optional(Type.String({ minLength: 1 })),
    phase: Type.Union([
      Type.Literal('creating'),
      Type.Literal('materializing'),
      Type.Literal('ready'),
    ]),
  },
  { additionalProperties: false },
);
type ThreadRecord = Static<typeof recordSchema>;
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: Type.String(),
    records: Type.Array(recordSchema),
  },
  { additionalProperties: false },
);
export interface AutomationThread {
  id: string;
  name?: string;
  archived?: boolean;
  incarnation?: string;
  model?: string;
  effort?: string;
  group?: string;
}
export type AutomationThreadSettings = Pick<AutomationThread, 'model' | 'effort'>;
export interface AutomationThreadModelObservation {
  requested: AutomationThreadSettings;
  observed: AutomationThreadSettings;
}
export function automationSettingsMessage(settings: AutomationThreadModelObservation) {
  const pair = (value: AutomationThreadSettings) =>
    `${value.model ?? 'native/unknown'} / ${value.effort ?? 'native/unknown'}`;
  return `requested: ${pair(settings.requested)}; observed: ${pair(settings.observed)}`;
}
export class AutomationThreadSettingsError extends AutomationError {
  constructor(
    code: string,
    readonly settings: AutomationThreadModelObservation,
  ) {
    super(code);
  }
}

export interface AutomationThreadAdapter {
  /** exact lookup only. Null means confirmed absence, never a failed lookup. */
  lookup(id: string): Promise<AutomationThread | null>;
  lookupFresh?(id: string): Promise<AutomationThread | null>;
  validateSettings?(settings: AutomationThreadSettings, current?: AutomationThread): Promise<void>;
  /** persist the native identity before any subsequent operation. must tolerate a retained journal. */
  create(
    record: Readonly<ThreadRecord>,
    saveId: (id: string) => Promise<void>,
    fresh: boolean,
    settings?: AutomationThreadSettings,
  ): Promise<string>;
  updateSettings?(current: AutomationThread, settings: AutomationThreadSettings): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  setGroup?(id: string, group: string): Promise<void>;
}
export interface AutomationThreadSelection {
  key: string;
  exact?: string;
  name?: string;
  managed: boolean;
  group?: string;
}

/** titles never identify conversations; Codex partitions shared declarations by stable job identity. */
export function automationThreadSelection(
  job: ResolvedAutomation,
  runtime: AutomationRuntime,
): AutomationThreadSelection | undefined {
  if (job.payload.kind !== 'prompt') return;
  const target = job.overrides[runtime]?.target;
  if (target === 'independent') return;
  const group = managedGroupName(
    job.group ?? defaultManagedGroup,
    runtime === 'openclaw' ? 512 : undefined,
  );
  if (target)
    return {
      key: automationHash(['native', target.thread]),
      exact: target.thread,
      managed: false,
      group,
    };
  if (!job.thread) return;
  return {
    key: automationHash(
      job.thread.id
        ? runtime === 'openclaw'
          ? ['shared', job.thread.id]
          : ['shared', job.thread.id, job.id]
        : ['job', job.id],
    ),
    ...(job.thread.id ? { exact: job.thread.id } : {}),
    ...(job.thread.name ? { name: job.thread.name } : {}),
    managed: true,
    group,
  };
}

export function automationThreadNames(jobs: ResolvedAutomation[], runtime: AutomationRuntime) {
  const names = new Map<string, string>();
  for (const job of jobs.filter((job) => job.runtimes.includes(runtime))) {
    const selection = automationThreadSelection(job, runtime);
    if (!selection?.name) continue;
    const previous = names.get(selection.key);
    if (previous !== undefined && previous !== selection.name) {
      const error = new AutomationError('automation-thread-name-conflict');
      error.automationId = job.id;
      throw error;
    }
    names.set(selection.key, selection.name);
  }
  return names;
}

/** private binding journal; readers never create files or take mutation locks. */
export default class AutomationThreads {
  readonly file: PrivateStateFile;
  readonly path: string;
  constructor(
    readonly options: { root: string; scope: string; runtime: AutomationRuntime },
    readonly adapter: AutomationThreadAdapter,
  ) {
    this.path = join(options.root, `automation-threads-${options.scope}.json`);
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [options.root],
      currentUid: process.getuid?.(),
      label: 'Automation conversations',
      maximumBytes: 1024 * 1024,
    });
  }
  async read() {
    try {
      const contents = await this.file.read();
      const ledger: unknown =
        contents === undefined
          ? { version: 1, scope: this.options.scope, records: [] }
          : JSON.parse(contents);
      if (
        !Value.Check(ledgerSchema, ledger) ||
        ledger.scope !== this.options.scope ||
        new Set(ledger.records.map((r) => r.key)).size !== ledger.records.length ||
        ledger.records.some((r) => r.phase !== 'creating' && !r.nativeId)
      )
        throw new Error('invalid ledger');
      return ledger;
    } catch {
      throw new AutomationError('automation-thread-ownership-invalid');
    }
  }
  async resolve(jobs: ResolvedAutomation[], apply = false) {
    let automationId: string | undefined;
    const run = async () => {
      const ledger = await this.read();
      const save = () => this.file.write(JSON.stringify(ledger));
      const names = automationThreadNames(jobs, this.options.runtime);
      const selected = jobs
        .filter((job) => job.runtimes.includes(this.options.runtime))
        .flatMap((job) => {
          const selection = automationThreadSelection(job, this.options.runtime);
          return selection ? [{ job, selection }] : [];
        });
      const prepared = new Map<
        string,
        {
          selection: AutomationThreadSelection;
          record?: ThreadRecord;
          native: AutomationThread | null;
          settings?: AutomationThreadSettings;
          replace?: boolean;
          automationId: string;
        }
      >();
      const nativeNames = new Map<string, string>();
      const groups = new Map<string, string>();
      for (const { job, selection } of selected) {
        automationId = job.id;
        const previous = groups.get(selection.key);
        if (previous !== undefined && previous !== selection.group)
          throw new AutomationError('automation-thread-group-conflict');
        groups.set(selection.key, selection.group!);
      }
      const nativeGroups = new Map<string, string>();
      const settingsFor = (job: ResolvedAutomation) => {
        const override = job.overrides[this.options.runtime];
        return {
          ...(override?.model === undefined ? {} : { model: override.model }),
          ...(override?.effort === undefined ? {} : { effort: override.effort }),
        };
      };
      const settingsByKey = new Map<string, AutomationThreadSettings>();
      const nativeSettings = new Map<string, AutomationThreadSettings>();
      const checkSettings = (
        map: Map<string, AutomationThreadSettings>,
        key: string,
        settings: AutomationThreadSettings,
      ) => {
        const previous = map.get(key);
        if (previous && (previous.model !== settings.model || previous.effort !== settings.effort))
          throw new AutomationError('automation-thread-settings-conflict');
        map.set(key, settings);
      };
      for (const { job, selection } of selected) {
        automationId = job.id;
        const settings = settingsFor(job);
        if (!selection.managed && (settings.model || settings.effort))
          throw new AutomationError('automation-thread-settings-unowned');
        checkSettings(settingsByKey, selection.key, settings);
      }
      // verify every existing target and all aliases before the first mutation.
      for (const { job, selection } of selected) {
        automationId = job.id;
        if (prepared.has(selection.key)) continue;
        const record = ledger.records.find((r) => r.key === selection.key);
        const id = record?.nativeId ?? selection.exact;
        const native = id
          ? await (record?.settingsUpdate && this.adapter.lookupFresh
              ? this.adapter.lookupFresh(id)
              : this.adapter.lookup(id))
          : null;
        if (
          record?.settingsUpdate &&
          (!native ||
            native.archived ||
            record.settingsUpdate.nativeId !== native.id ||
            record.settingsUpdate.incarnation !== native.incarnation)
        )
          throw new AutomationError('automation-thread-settings-conflict');
        const replace = Boolean(
          record?.phase === 'ready' &&
          (!native || native.archived) &&
          selection.managed &&
          job.id === 'github-issue-assignment',
        );
        if (replace && !apply) throw new AutomationError('automation-thread-replacement-required');
        if (record && record.phase === 'ready' && !native && !replace)
          throw new AutomationError('automation-thread-recovery-required');
        if (native?.archived && !replace)
          throw new AutomationError('automation-thread-unavailable');
        if (!selection.managed && !native) throw new AutomationError('automation-thread-missing');
        if (native) {
          const previous = nativeGroups.get(native.id);
          if (previous !== undefined && previous !== selection.group)
            throw new AutomationError('automation-thread-group-conflict');
          nativeGroups.set(native.id, selection.group!);
        }
        if (record && record.phase !== 'ready' && !apply)
          throw new AutomationError('automation-thread-recovery-required');
        const name = names.get(selection.key);
        if (native && name) {
          const previous = nativeNames.get(native.id);
          if (previous !== undefined && previous !== name)
            throw new AutomationError('automation-thread-name-conflict');
          nativeNames.set(native.id, name);
        }
        const settings = selection.managed ? settingsFor(job) : undefined;
        if (native && settings) checkSettings(nativeSettings, native.id, settings);
        prepared.set(selection.key, {
          selection,
          record,
          native,
          settings,
          replace,
          automationId: job.id,
        });
      }
      // Reject unavailable selections before journaling a potentially ambiguous native create.
      if (this.adapter.validateSettings) {
        for (const { settings, native, record, automationId: id } of prepared.values()) {
          automationId = id;
          if (!settings || (!settings.model && !settings.effort) || record?.settingsUpdate)
            continue;
          try {
            await this.adapter.validateSettings(settings, native ?? undefined);
          } catch (error) {
            if (error instanceof AutomationError)
              throw new AutomationThreadSettingsError(error.code, {
                requested: settings,
                observed: { model: native?.model, effort: native?.effort },
              });
            throw error;
          }
        }
      }
      if (this.options.runtime === 'codex') {
        const active = new Set<string>();
        for (const { job, selection } of selected) {
          automationId = job.id;
          const id = prepared.get(selection.key)?.native?.id;
          if (id && job.enabled && active.has(id))
            throw new AutomationError('automation-thread-schedule-conflict');
          if (id && job.enabled) active.add(id);
        }
      }
      const resolved = new Map<
        string,
        {
          id: string;
          outcome: 'created' | 'bound' | 'reused';
          name?: string;
          settings?: AutomationThreadModelObservation;
        }
      >();
      const reconciledNative = new Map<string, AutomationThread>();
      for (const [key, entry] of prepared) {
        automationId = entry.automationId;
        const { selection, settings } = entry;
        let { record, native } = entry;
        if (native) native = reconciledNative.get(native.id) ?? native;
        let outcome: 'created' | 'bound' | 'reused' = record ? 'reused' : 'bound';
        if (entry.replace || !native || (record && record.phase !== 'ready')) {
          if (!apply) throw new AutomationError('automation-thread-sync-required');
          const fresh = !record || entry.replace === true;
          if (entry.replace && record) {
            record.retiredId = record.nativeId;
            delete record.nativeId;
            record.generation = randomUUID();
            record.phase = 'creating';
            await save();
          }
          if (!record) {
            record = { key, phase: 'creating' };
            ledger.records.push(record);
            await save();
          }
          const pending = record;
          const id = await this.adapter
            .create(
              pending,
              async (nativeId) => {
                pending.nativeId = nativeId;
                pending.phase = 'materializing';
                await save();
              },
              fresh,
              settings,
            )
            .catch((error: unknown) => {
              if (
                this.options.runtime === 'openclaw' &&
                error instanceof AutomationError &&
                error.diagnostic?.method === 'sessions.create'
              )
                throw new AutomationError(error.code, {
                  ...error.diagnostic,
                  automationId: entry.automationId,
                });
              throw error;
            });
          native = await this.adapter.lookup(id);
          if (!native || native.archived || native.id !== id)
            throw new AutomationError('automation-thread-readback-diverged');
          record.nativeId = native.id;
          record.phase = 'ready';
          await save();
          outcome = 'created';
        }
        if (selection.managed && !record && !apply)
          throw new AutomationError('automation-thread-sync-required');
        const name = names.get(key);
        if (name !== undefined && native.name !== name) {
          if (!apply) throw new AutomationError('automation-thread-name-drift');
          await this.adapter.rename(native.id, name);
          const readback = await this.adapter.lookup(native.id);
          if (!readback || readback.name !== name)
            throw new AutomationError('automation-thread-readback-diverged');
          native = readback;
        }
        if (selection.group !== undefined && native.group !== selection.group) {
          if (!apply) throw new AutomationError('automation-thread-group-drift');
          if (!this.adapter.setGroup)
            throw new AutomationError('automation-thread-group-unsupported');
          await this.adapter.setGroup(native.id, selection.group);
          const readback = await this.adapter.lookup(native.id);
          if (!readback || readback.group !== selection.group)
            throw new AutomationError('automation-thread-readback-diverged');
          native = readback;
        }
        const settingsMatch = (thread: AutomationThread) =>
          !settings ||
          ((settings.model === undefined || thread.model === settings.model) &&
            (settings.effort === undefined || thread.effort === settings.effort));
        const observation = (): AutomationThreadModelObservation => ({
          requested: settings ?? {},
          observed: {
            ...(native!.model === undefined ? {} : { model: native!.model }),
            ...(native!.effort === undefined ? {} : { effort: native!.effort }),
          },
        });
        const settingsError = (code: string) =>
          new AutomationThreadSettingsError(code, observation());
        if (record?.settingsUpdate) {
          const pending = record.settingsUpdate;
          if (pending.nativeId !== native.id || pending.incarnation !== native.incarnation)
            throw new AutomationError('automation-thread-settings-conflict');
          const pendingMatch =
            (pending.desired.model === undefined || native.model === pending.desired.model) &&
            (pending.desired.effort === undefined || native.effort === pending.desired.effort);
          if (!pendingMatch) {
            const retrySafe = pending.phase === 'busy' || pending.phase === 'unsupported';
            if (!apply || !retrySafe)
              throw new AutomationThreadSettingsError(
                `automation-thread-settings-${pending.phase}`,
                {
                  requested: pending.desired,
                  observed: observation().observed,
                },
              );
            if (
              native.model !== pending.baseline.model ||
              native.effort !== pending.baseline.effort
            )
              throw settingsError('automation-thread-settings-conflict');
          }
          if (apply) {
            delete record.settingsUpdate;
            await save();
          }
        }
        if (!settingsMatch(native)) {
          if (!this.adapter.updateSettings)
            throw settingsError('automation-thread-settings-unsupported');
          if (!apply) throw settingsError('automation-thread-model-drift');
          if (!record) {
            record = { key, phase: 'ready', nativeId: native.id };
            ledger.records.push(record);
          }
          record.settingsUpdate = {
            nativeId: native.id,
            ...(native.incarnation ? { incarnation: native.incarnation } : {}),
            desired: settings!,
            baseline: { model: native.model, effort: native.effort },
            phase: 'uncertain',
          };
          await save();
          let failure: unknown;
          try {
            await this.adapter.updateSettings(native, settings!);
          } catch (error) {
            failure = error;
          }
          // a lost acknowledgement can still have committed; read before considering any replay.
          const observed = await (
            this.adapter.lookupFresh
              ? this.adapter.lookupFresh(native.id)
              : this.adapter.lookup(native.id)
          ).catch(() => null);
          if (observed && observed.incarnation === native.incarnation && settingsMatch(observed)) {
            delete record.settingsUpdate;
            await save();
            native = observed;
          } else {
            if (failure instanceof AutomationError) {
              if (
                [
                  'automation-thread-settings-conflict',
                  'automation-model-unsupported',
                  'automation-effort-unsupported',
                ].includes(failure.code)
              )
                delete record.settingsUpdate;
              else if (failure.code === 'automation-thread-settings-denied')
                record.settingsUpdate.phase = 'denied';
              else if (failure.code === 'automation-thread-settings-busy')
                record.settingsUpdate.phase = 'busy';
              else if (failure.code === 'automation-thread-settings-unsupported')
                record.settingsUpdate.phase = 'unsupported';
              await save();
              throw settingsError(failure.code);
            }
            throw settingsError('automation-thread-settings-uncertain');
          }
        }
        if (selection.managed && apply && (!record || record.phase !== 'ready')) {
          if (!record) {
            record = { key, phase: 'ready', nativeId: native.id };
            ledger.records.push(record);
          }
          record.nativeId = native.id;
          record.phase = 'ready';
          await save();
        }
        reconciledNative.set(native.id, native);
        resolved.set(key, {
          id: native.id,
          outcome,
          ...(selection.managed ? { settings: observation() } : {}),
          ...(native.name ? { name: native.name } : {}),
        });
      }
      return new Map(selected.map(({ job, selection }) => [job.id, resolved.get(selection.key)!]));
    };
    const resolve = async () => {
      try {
        return await run();
      } catch (error) {
        // retain the original subtype, settings observation, code, and safe diagnostic.
        if (error instanceof AutomationError) error.automationId ??= automationId;
        else if (!apply && automationId) {
          const failure = new AutomationError('automation-thread-inspection-failed');
          failure.automationId = automationId;
          throw failure;
        }
        throw error;
      }
    };
    if (!apply) return resolve();
    await ensurePrivateStateDirectories({
      directories: [this.options.root],
      currentUid: process.getuid?.(),
      label: 'Automation conversations',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
      staleMs: 30000,
    });
    try {
      return await resolve();
    } finally {
      await lock.release();
    }
  }
}
