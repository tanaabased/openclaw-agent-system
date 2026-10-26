import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { automationHash } from './automation-hash.ts';
import { AutomationError } from './automation-gateway.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';

export { automationHash } from './automation-hash.ts';

const hashSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
const recordSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
    marker: Type.String(),
    nativeId: Type.Optional(Type.String()),
    hash: hashSchema,
    nativeHash: Type.Optional(hashSchema),
    triggerHash: hashSchema,
    generation: Type.Integer({ minimum: 1 }),
    anchorMs: Type.Number(),
    removed: Type.Boolean(),
    retired: Type.Optional(
      Type.Object(
        {
          atMs: Type.Integer({ minimum: 0, maximum: 8.64e15 }),
          reason: Type.Literal('native-job-absent'),
        },
        { additionalProperties: false },
      ),
    ),
    completion: Type.Optional(Type.String()),
    pending: Type.Optional(
      Type.Object(
        {
          kind: Type.Union([Type.Literal('create'), Type.Literal('update')]),
          nativeHash: hashSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: hashSchema,
    records: Type.Array(recordSchema),
  },
  { additionalProperties: false },
);
export type AutomationRecord = Static<typeof recordSchema>;
export type AutomationLedger = Static<typeof ledgerSchema>;

/** non-secret ownership state, separate from native scheduler storage and repository content. */
export default class AutomationStore {
  readonly scope: string;
  readonly path: string;
  readonly file: PrivateStateFile;
  constructor(
    readonly options: { root: string; profile: string; agentId: string; workspaceDir: string },
  ) {
    this.scope = automationHash({
      runtime: 'openclaw',
      profile: options.profile,
      agentId: options.agentId,
      workspaceDir: options.workspaceDir,
    });
    this.path = join(options.root, `automations-${this.scope}.json`);
    this.file = new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [options.root],
      label: 'automation ownership',
      maximumBytes: 1024 * 1024,
      path: this.path,
    });
  }
  marker(id: string): string {
    return `agent-system:${this.scope}:${id}`;
  }
  async read(): Promise<AutomationLedger> {
    try {
      const contents = await this.file.read();
      if (contents === undefined) return { version: 1, scope: this.scope, records: [] };
      const parsed: unknown = JSON.parse(contents);
      if (
        !Value.Check(ledgerSchema, parsed) ||
        parsed.scope !== this.scope ||
        new Set(parsed.records.map(({ id }) => id)).size !== parsed.records.length ||
        parsed.records.some(
          (record) =>
            record.marker !== this.marker(record.id) ||
            (record.retired && (!record.removed || record.pending || !record.nativeId)),
        )
      ) {
        throw new Error('invalid ledger');
      }
      return parsed;
    } catch {
      throw new AutomationError('automation-ownership-invalid');
    }
  }
  async write(ledger: AutomationLedger): Promise<void> {
    if (
      !Value.Check(ledgerSchema, ledger) ||
      ledger.scope !== this.scope ||
      ledger.records.some(
        (record) => record.retired && (!record.removed || record.pending || !record.nativeId),
      )
    ) {
      throw new AutomationError('automation-ownership-invalid');
    }
    await this.file.write(`${JSON.stringify(ledger)}\n`);
  }
  async withLock<T>(run: () => Promise<T>): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.options.root],
      currentUid: process.getuid?.(),
      label: 'Automation ownership',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
      staleMs: 30_000,
    });
    try {
      return await withPrivateStateLock(lock, run);
    } finally {
      await lock.release();
    }
  }
}
