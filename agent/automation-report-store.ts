import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

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

/** one bounded occurrence per file; an oversized save cannot replace the committed record. */
export default class AutomationReportStore {
  constructor(readonly root: string) {}
  file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('automation-report-id-invalid');
    return new PrivateStateFile({
      path: join(this.root, `${id}.json`),
      directories: [this.root],
      currentUid: process.getuid?.(),
      // two 16 kib streams can expand sixfold under json escaping; reserve metadata headroom.
      maximumBytes: 256 * 1024,
      label: 'automation report',
    });
  }
  async read(id: string): Promise<AutomationReportRecord | undefined> {
    const data = await this.file(id).read();
    if (data === undefined) return;
    const value: unknown = JSON.parse(data);
    if (!Value.Check(schema, value) || value.executionId !== id || value.input.executionId !== id)
      throw new Error('automation-report-record-invalid');
    return value;
  }
  async write(record: AutomationReportRecord) {
    if (!Value.Check(schema, record)) throw new Error('automation-report-record-invalid');
    await this.file(record.executionId).write(JSON.stringify(record));
  }
  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.file(id);
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'Automation reports',
    });
    const lock = await acquirePrivateStateFileLock(join(this.root, `${id}.json`), {
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
  async ids() {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }
}
