import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

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
const timestamp = Type.Number({ minimum: 0, maximum: 8.64e15 });
const timing = Type.Object(
  {
    commandFinishedAtMs: Type.Optional(timestamp),
    queuedAtMs: Type.Optional(timestamp),
    lastAttemptAtMs: Type.Optional(timestamp),
    submittedAtMs: Type.Optional(timestamp),
    admission: Type.Optional(
      Type.Union([Type.Literal('started'), Type.Literal('queued'), Type.Literal('ok')]),
    ),
    formatterStartedAtMs: Type.Optional(timestamp),
    messageRecordedAtMs: Type.Optional(timestamp),
    lastIssue: Type.Optional(
      Type.Object(
        {
          atMs: timestamp,
          phase: Type.Union([
            Type.Literal('prepare'),
            Type.Literal('submit'),
            Type.Literal('observe'),
          ]),
          reason: Type.String({ pattern: '^[a-z-]+$', maxLength: 120 }),
          category: Type.Union([
            Type.Literal('timeout'),
            Type.Literal('closed'),
            Type.Literal('rejected'),
            Type.Literal('unknown'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AutomationReportTiming = Static<typeof timing>;

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
    timing: Type.Optional(timing),
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
    private readonly storage: { agentId: string; agent: BoundStorage['agent'] },
    private readonly now = Date.now,
  ) {}
  private assertId(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('automation-report-id-invalid');
  }
  private async readSaved(id: string): Promise<unknown> {
    this.assertId(id);
    const rows = await this.storage.agent
      .read({ automationReports: { executionId: id } })
      .catch((error: unknown) => {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        return { automationReports: [] };
      });
    const row = rows.automationReports[0];
    return row && reportRecord(row);
  }
  async read(id: string): Promise<AutomationReportRecord | undefined> {
    return this.validate(id, await this.readSaved(id));
  }
  private validate(id: string, value: unknown) {
    if (value === undefined) return;
    if (
      !Value.Check(schema, value) ||
      value.target.agentId !== this.storage.agentId ||
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
    this.assertId(id);
    const prepare = (current?: AutomationReportRecord) => {
      const next = operation(current);
      if (next === 'keep' || !next) return next;
      this.validate(id, next);
      if (terminal(next)) next.completedAt ??= new Date(this.now()).toISOString();
      if (Buffer.byteLength(JSON.stringify(next)) > maximumBytes)
        throw new Error('The automation report exceeds its size limit.');
      return next;
    };
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

  retain(id: string, create: (nowMs: number) => AutomationReportRecord | undefined) {
    return this.change(id, (current) => (current ? 'keep' : create(this.now())));
  }

  async update(id: string, operation: (record: AutomationReportRecord, nowMs: number) => void) {
    const record = await this.change(id, (current) => {
      if (!current) throw new Error('automation-report-record-missing');
      operation(current, this.now());
      return current;
    });
    return record!;
  }
  ids() {
    return this.storage.agent.listReportIds('all');
  }
  expired(startedAt: string) {
    const started = Date.parse(startedAt);
    return !Number.isFinite(started) || started <= this.now() - reportLifetimeMs;
  }
  recoveryIds() {
    return this.storage.agent.listReportIds('recoverable');
  }
  private pruneOne(id: string) {
    return this.change(id, (record) =>
      record && terminal(record) && record.completedAt && this.expired(record.completedAt)
        ? undefined
        : 'keep',
    );
  }
  async prune() {
    const completedBefore = new Date(this.now() - reportLifetimeMs).toISOString();
    for (const id of await this.storage.agent.listReportIds({ completedBefore }))
      await this.pruneOne(id);
  }
}
