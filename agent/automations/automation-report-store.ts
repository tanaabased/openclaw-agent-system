import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock from '../../core/private-state-file-lock.ts';
import PrivateStateFile from '../../core/private-state-file.ts';
import { withPrivateStateLock } from '../../core/private-state-lock-context.ts';

import type { AgentRows } from '../storage/workflow-records.ts';
import type { BoundStorage } from '../storage/storage-lifecycle.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';

// two 16 kib streams can expand sixfold under json escaping; reserve metadata headroom.
const maximumBytes = 256 * 1024;
export const reportLifetimeMs = 30 * 24 * 60 * 60 * 1000;

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
        displayName: Type.Optional(text),
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
        presentation: Type.Optional(
          Type.Union([
            Type.Object(
              { kind: Type.Literal('fallback'), footer: text },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal('preferred'), body: text },
              { additionalProperties: false },
            ),
            Type.Object(
              { kind: Type.Literal('diagnostic'), body: text, code: text },
              { additionalProperties: false },
            ),
          ]),
        ),
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

export function reportRow(record: AutomationReportRecord): AgentRows['automationReports'] {
  const { state, completedAt, ...value } = record;
  return { executionId: record.executionId, state, completedAt: completedAt ?? null, value };
}

function reportRecord(row: AgentRows['automationReports']) {
  return {
    ...row.value,
    state: row.state,
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
  };
}

function terminal(record: AutomationReportRecord) {
  return record.state === 'delivered' || record.state === 'failed';
}

/** one bounded record per occurrence; an oversized save cannot replace the committed record. */
export default class AutomationReportStore {
  constructor(
    readonly root: string,
    private readonly now = Date.now,
    private readonly storage?: { agentId: string; agent: BoundStorage['agent'] },
  ) {}
  private stateFile(name: string, directory = this.root) {
    return new PrivateStateFile({
      path: join(directory, name),
      directories: directory === this.root ? [this.root] : [this.root, directory],
      currentUid: process.getuid?.(),
      maximumBytes,
      label: 'automation report',
    });
  }
  file(id: string, completed = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('automation-report-id-invalid');
    return this.stateFile(`${id}.json`, completed ? join(this.root, 'completed') : this.root);
  }
  private async readSaved(id: string): Promise<unknown> {
    const file = this.file(id);
    if (this.storage) {
      const rows = await this.storage.agent
        .read({ automationReports: { executionId: id } })
        .catch((error: unknown) => {
          if (nodeErrorCode(error) !== 'ENOENT') throw error;
          return { automationReports: [] };
        });
      const row = rows.automationReports[0];
      return row && reportRecord(row);
    }
    // A terminal write commits before removing its active copy; terminal evidence wins a crash.
    const data = (await this.file(id, true).read()) ?? (await file.read());
    return data === undefined ? undefined : JSON.parse(data);
  }
  async read(id: string): Promise<AutomationReportRecord | undefined> {
    return this.validate(id, await this.readSaved(id));
  }
  private validate(id: string, value: unknown) {
    if (value === undefined) return;
    if (
      !Value.Check(schema, value) ||
      (this.storage && value.target.agentId !== this.storage.agentId) ||
      value.executionId !== id ||
      value.input.executionId !== id ||
      (value.completedAt !== undefined && !Number.isFinite(Date.parse(value.completedAt)))
    )
      throw new Error('automation-report-record-invalid');
    return value;
  }
  private async change(
    id: string,
    operation: (current?: AutomationReportRecord) => AutomationReportRecord | 'keep' | undefined,
  ) {
    this.file(id);
    const prepare = (current?: AutomationReportRecord) => {
      const next = operation(current);
      if (next === 'keep' || !next) return next;
      this.validate(id, next);
      if (terminal(next)) next.completedAt ??= new Date(this.now()).toISOString();
      if (Buffer.byteLength(JSON.stringify(next)) > maximumBytes)
        throw new Error('The automation report exceeds its size limit.');
      return next;
    };
    if (this.storage) {
      let result: AutomationReportRecord | undefined;
      await this.storage.agent.changeReport(id, (row) => {
        const current = row && this.validate(id, reportRecord(row));
        const next = prepare(current);
        if (next === 'keep') {
          result = current;
          return row;
        }
        result = next;
        return result && reportRow(result);
      });
      return result;
    }
    return this.locked(`${id}.json`, async () => {
      const current = await this.read(id);
      const result = prepare(current);
      if (result === 'keep') return current;
      if (result) {
        const completed = terminal(result);
        await this.file(id, completed).write(JSON.stringify(result));
        if (completed) await this.file(id).remove();
      } else if (current) {
        await this.file(id).remove();
        await this.file(id, true).remove();
      }
      return result;
    });
  }

  retain(id: string, create: () => AutomationReportRecord | undefined) {
    return this.change(id, (current) => (current ? 'keep' : create()));
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
    const record = await this.change(id, (current) => {
      if (!current) throw new Error('automation-report-record-missing');
      operation(current);
      return current;
    });
    return record!;
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
    if (this.storage) return this.storage.agent.listReportIds('all');
    return [
      ...new Set([
        ...(await this.directoryIds(this.root)),
        ...(await this.directoryIds(join(this.root, 'completed'))),
      ]),
    ];
  }
  expired(startedAt: string) {
    const started = Date.parse(startedAt);
    return !Number.isFinite(started) || started <= this.now() - reportLifetimeMs;
  }
  /** Terminal records live separately; legacy records move when recovery reconciles them. */
  async recoveryIds() {
    if (this.storage) return this.storage.agent.listReportIds('recoverable');
    return this.directoryIds(this.root);
  }
  private pruneOne(id: string) {
    return this.change(id, (record) =>
      record && terminal(record) && record.completedAt && this.expired(record.completedAt)
        ? undefined
        : 'keep',
    );
  }
  async prune() {
    if (this.storage) {
      const completedBefore = new Date(this.now() - reportLifetimeMs).toISOString();
      for (const id of await this.storage.agent.listReportIds({ completedBefore }))
        await this.pruneOne(id);
      return;
    }
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
      for (const id of await this.directoryIds(join(this.root, 'completed')))
        await this.pruneOne(id);
      await checkpoint.write(JSON.stringify(this.now()));
    });
  }
}
