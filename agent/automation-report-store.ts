import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { historyLifetimeMs } from './history-state.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const text = Type.String();
const stream = Type.Object(
  {
    body: text,
    omittedBytes: Type.Number(),
    format: Type.Union([Type.Literal('json'), Type.Literal('text'), Type.Literal('empty')]),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    version: Type.Literal(1),
    executionId: text,
    hash: text,
    manifestDigest: text,
    target: Type.Object(
      {
        sessionKey: text,
        sessionId: Type.Optional(text),
        agentId: text,
        workspaceDir: text,
        scope: text,
        model: Type.Optional(text),
        effort: Type.Optional(text),
      },
      { additionalProperties: false },
    ),
    input: Type.Object(
      {
        id: text,
        executionId: text,
        startedAt: text,
        outcome: Type.Union([
          Type.Literal('success'),
          Type.Literal('error'),
          Type.Literal('unknown'),
        ]),
        reason: text,
        runLine: text,
        stdout: stream,
        stderr: stream,
        captureIncomplete: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    state: Type.Union([
      Type.Literal('pending'),
      Type.Literal('sending'),
      Type.Literal('submitted'),
      Type.Literal('delivered'),
      Type.Literal('failed'),
      Type.Literal('uncertain'),
    ]),
    completedAt: Type.Optional(text),
    code: Type.Optional(text),
    messageId: Type.Optional(text),
    guarded: Type.Optional(Type.Boolean()),
    effective: Type.Optional(
      Type.Object(
        { model: text, effort: Type.Optional(text), harness: Type.Optional(text) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type AutomationReportRecord = Static<typeof schema>;

function terminal(record: AutomationReportRecord) {
  return record.state === 'delivered' || record.state === 'failed';
}

/** one bounded occurrence per file; an oversized save cannot replace the committed record. */
export default class AutomationReportStore {
  constructor(
    readonly root: string,
    private readonly now = Date.now,
  ) {}
  private stateFile(name: string, directory = this.root) {
    return new PrivateStateFile({
      path: join(directory, name),
      directories: directory === this.root ? [this.root] : [this.root, directory],
      currentUid: process.getuid?.(),
      // two 16 kib streams can expand sixfold under json escaping; reserve metadata headroom.
      maximumBytes: 256 * 1024,
      label: 'automation report',
    });
  }
  file(id: string, completed = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('automation-report-id-invalid');
    return this.stateFile(`${id}.json`, completed ? join(this.root, 'completed') : this.root);
  }
  async read(id: string): Promise<AutomationReportRecord | undefined> {
    // A terminal write commits before removing its active copy; terminal evidence wins a crash.
    const data = (await this.file(id, true).read()) ?? (await this.file(id).read());
    if (data === undefined) return;
    const value: unknown = JSON.parse(data);
    if (
      !Value.Check(schema, value) ||
      value.executionId !== id ||
      value.input.executionId !== id ||
      (value.completedAt !== undefined && !Number.isFinite(Date.parse(value.completedAt)))
    )
      throw new Error('automation-report-record-invalid');
    return value;
  }
  async write(record: AutomationReportRecord) {
    if (!Value.Check(schema, record)) throw new Error('automation-report-record-invalid');
    const completed = terminal(record);
    if (completed) record.completedAt ??= new Date(this.now()).toISOString();
    await this.file(record.executionId, completed).write(JSON.stringify(record));
    if (completed) await this.file(record.executionId).remove();
  }
  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.file(id);
    return this.locked(`${id}.json`, operation);
  }
  private async locked<T>(name: string, operation: () => Promise<T>): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'Automation reports',
    });
    const lock = await acquirePrivateStateFileLock(join(this.root, name), {
      retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
      staleMs: 30_000,
    });
    try {
      return await withPrivateStateLock(lock, operation);
    } finally {
      await lock.release();
    }
  }
  async update(id: string, operation: (record: AutomationReportRecord) => void) {
    return this.withLock(id, async () => {
      const record = await this.read(id);
      if (!record) throw new Error('automation-report-record-missing');
      operation(record);
      await this.write(record);
      return record;
    });
  }
  private async directoryIds(directory: string) {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }
  async ids() {
    return [
      ...new Set([
        ...(await this.directoryIds(this.root)),
        ...(await this.directoryIds(join(this.root, 'completed'))),
      ]),
    ];
  }
  expired(startedAt: string) {
    const started = Date.parse(startedAt);
    return !Number.isFinite(started) || started <= this.now() - historyLifetimeMs;
  }
  /** Terminal records live separately; legacy records move when recovery reconciles them. */
  async recoveryIds() {
    return this.directoryIds(this.root);
  }
  async prune() {
    const checkpoint = this.stateFile('maintenance.json');
    const due = async () => {
      const saved = await checkpoint.read();
      if (saved === undefined) return true;
      const previous: unknown = JSON.parse(saved);
      if (typeof previous !== 'number' || !Number.isFinite(previous))
        throw new Error('automation-report-maintenance-invalid');
      return this.now() - previous >= 24 * 60 * 60 * 1000;
    };
    if (!(await due())) return;
    await this.locked('maintenance.json', async () => {
      if (!(await due())) return;
      for (const id of await this.directoryIds(join(this.root, 'completed'))) {
        await this.withLock(id, async () => {
          const record = await this.read(id);
          if (
            record &&
            terminal(record) &&
            record.completedAt &&
            this.expired(record.completedAt)
          ) {
            // Finish an interrupted migration before removing its terminal copy.
            await this.file(id).remove();
            await this.file(id, true).remove();
          }
        });
      }
      await checkpoint.write(JSON.stringify(this.now()));
    });
  }
}
