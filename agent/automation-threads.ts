import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { AutomationError } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import type { AutomationRuntime, ResolvedAutomation } from '../manifest/automation-schema.ts';

const recordSchema = Type.Object(
  {
    key: Type.String(),
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
  model?: string;
  effort?: string;
}
export type AutomationThreadSettings = Pick<AutomationThread, 'model' | 'effort'>;
export interface AutomationThreadAdapter {
  /** exact lookup only. Null means confirmed absence, never a failed lookup. */
  lookup(id: string): Promise<AutomationThread | null>;
  /** persist the native identity before any subsequent operation. must tolerate a retained journal. */
  create(
    record: Readonly<ThreadRecord>,
    saveId: (id: string) => Promise<void>,
    fresh: boolean,
    settings?: AutomationThreadSettings,
  ): Promise<string>;
  rename(id: string, name: string): Promise<void>;
}
export interface AutomationThreadSelection {
  key: string;
  exact?: string;
  name?: string;
  managed: boolean;
}

/** titles never identify conversations; Codex partitions shared declarations by stable job identity. */
export function automationThreadSelection(
  job: ResolvedAutomation,
  runtime: AutomationRuntime,
): AutomationThreadSelection | undefined {
  if (job.payload.kind !== 'prompt') return;
  const target = job.overrides[runtime]?.target;
  if (target === 'independent') return;
  if (target)
    return { key: automationHash(['native', target.thread]), exact: target.thread, managed: false };
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
  };
}

export function automationThreadNames(jobs: ResolvedAutomation[], runtime: AutomationRuntime) {
  const names = new Map<string, string>();
  for (const job of jobs.filter((job) => job.runtimes.includes(runtime))) {
    const selection = automationThreadSelection(job, runtime);
    if (!selection?.name) continue;
    const previous = names.get(selection.key);
    if (previous !== undefined && previous !== selection.name)
      throw new AutomationError('automation-thread-name-conflict');
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
        }
      >();
      const nativeNames = new Map<string, string>();
      // verify every existing target and all aliases before the first mutation.
      for (const { job, selection } of selected) {
        if (prepared.has(selection.key)) continue;
        const record = ledger.records.find((r) => r.key === selection.key);
        const id = record?.nativeId ?? selection.exact;
        const native = id ? await this.adapter.lookup(id) : null;
        if (record && record.phase === 'ready' && !native)
          throw new AutomationError('automation-thread-recovery-required');
        if (!selection.managed && !native) throw new AutomationError('automation-thread-missing');
        if (record && record.phase !== 'ready' && !apply)
          throw new AutomationError('automation-thread-recovery-required');
        const name = names.get(selection.key);
        if (native && name) {
          const previous = nativeNames.get(native.id);
          if (previous !== undefined && previous !== name)
            throw new AutomationError('automation-thread-name-conflict');
          nativeNames.set(native.id, name);
        }
        const override = job.overrides.codex;
        const settings =
          this.options.runtime === 'codex' && selection.managed && override
            ? { model: override.model, effort: override.effort }
            : undefined;
        prepared.set(selection.key, { selection, record, native, settings });
      }
      if (this.options.runtime === 'codex') {
        const active = new Set<string>();
        for (const { job, selection } of selected) {
          const id = prepared.get(selection.key)?.native?.id;
          if (id && job.enabled && active.has(id))
            throw new AutomationError('automation-thread-schedule-conflict');
          if (id && job.enabled) active.add(id);
        }
      }
      const resolved = new Map<
        string,
        { id: string; outcome: 'created' | 'bound' | 'reused'; name?: string }
      >();
      for (const [key, entry] of prepared) {
        const { selection, settings } = entry;
        let { record, native } = entry;
        let outcome: 'created' | 'bound' | 'reused' = record ? 'reused' : 'bound';
        if (!native || (record && record.phase !== 'ready')) {
          if (!apply) throw new AutomationError('automation-thread-sync-required');
          const fresh = !record;
          if (!record) {
            record = { key, phase: 'creating' };
            ledger.records.push(record);
            await save();
          }
          const pending = record;
          const id = await this.adapter.create(
            pending,
            async (nativeId) => {
              pending.nativeId = nativeId;
              pending.phase = 'materializing';
              await save();
            },
            fresh,
            settings,
          );
          native = await this.adapter.lookup(id);
          if (!native || native.id !== id)
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
        const settingsMatch = (thread: AutomationThread) =>
          !settings ||
          ((settings.model === undefined || thread.model === settings.model) &&
            (settings.effort === undefined || thread.effort === settings.effort));
        if (!settingsMatch(native)) throw new AutomationError('automation-thread-model-drift');
        if (selection.managed && apply && (!record || record.phase !== 'ready')) {
          if (!record) {
            record = { key, phase: 'ready', nativeId: native.id };
            ledger.records.push(record);
          }
          record.nativeId = native.id;
          record.phase = 'ready';
          await save();
        }
        resolved.set(key, {
          id: native.id,
          outcome,
          ...(native.name ? { name: native.name } : {}),
        });
      }
      return new Map(selected.map(({ job, selection }) => [job.id, resolved.get(selection.key)!]));
    };
    if (!apply) return run();
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
      return await run();
    } finally {
      await lock.release();
    }
  }
}
