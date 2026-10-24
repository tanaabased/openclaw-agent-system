import { selectedProfileSchema } from './model-routing.ts';
import { Type, type Static } from 'typebox';

import {
  intakeRecordSchema,
  type IntakeRecord,
  type IntakeState,
} from '../channels/github/intake/record-store.ts';
import { assessmentConfigurationSchema } from '../manifest/assessment-schema.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const mode = Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]);
export const operatorIssueSchema = Type.Object(
  {
    ...Type.Omit(intakeRecordSchema, ['assignment', 'evidence']).properties,
    initiation: Type.Object(
      {
        kind: Type.Literal('operator'),
        session: text,
        incarnation: text,
        turn: text,
        input: text,
      },
      { additionalProperties: false },
    ),
    evidence: Type.Object(
      {
        policyDigest: text,
        mode,
        open: Type.Literal(true),
        repositoryReadable: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    selections: Type.Optional(
      Type.Object(
        {
          mode: Type.Optional(mode),
          routing: Type.Optional(Type.Partial(selectedProfileSchema)),
          assessment: Type.Optional(assessmentConfigurationSchema),
          implementation: Type.Optional(assessmentConfigurationSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type OperatorIssue = Static<typeof operatorIssueSchema> & { assignment?: never };
export type ManagedIssue = IntakeRecord | OperatorIssue;
export type ManagedIssueState = Omit<IntakeState, 'records'> & { records: ManagedIssue[] };

/** operator initiation is retained by dispatch, never inserted into assignment scan state. */
export function dispatchAdmission(
  record: { intakeId?: string; manualIssue?: OperatorIssue },
  records: readonly ManagedIssue[],
): ManagedIssue | undefined {
  if (record.manualIssue) {
    if (record.intakeId) throw new Error('dispatch-origin-conflict');
    return record.manualIssue;
  }
  return records.find((entry) => entry.id === record.intakeId);
}

/** runtime projection only: scanner storage and assignment admission remain unchanged. */
export function managedIssueState(
  state: IntakeState | undefined,
  records: readonly { manualIssue?: OperatorIssue }[],
): ManagedIssueState | undefined {
  const manual = records.flatMap((record) => (record.manualIssue ? [record.manualIssue] : []));
  const first = manual[0];
  if (!state && !first) return;
  const base = state ?? {
    version: 1 as const,
    scope: first!.scope,
    workspaceDir: first!.workspaceDir,
    agentId: first!.agentId,
    account: first!.receiving,
    policyDigest: first!.evidence.policyDigest,
    baselineAt: first!.admittedAt,
    records: [],
  };
  return { ...base, records: [...base.records, ...manual] };
}
