import { projectCandidateSchema as pickupCandidateSchema } from '../channels/github/provider/issue-pickup-client.ts';
import { Type, type Static } from 'typebox';
import { providerDiagnosticSchema } from '../utils/provider-diagnostic.ts';
import { maximumAssessmentGuidanceBytes } from '../manifest/assessment-schema.ts';

import { issuePickupEnrollmentSchema, issuePickupReceiptSchema } from './issue-pickup-authority.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const assignmentFields = {
  window: issuePickupReceiptSchema.properties.window,
  assignedAt: time,
};
const chargeSchema = Type.Object(
  {
    ...assignmentFields,
    repository: text,
    repositoryNodeId: text,
    runId: text,
    reconciled: Type.Optional(
      Type.Object({ runId: text, at: time }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export const pickupOperationSchema = Type.Object(
  {
    id: text,
    runId: text,
    enrollment: Type.Optional(issuePickupEnrollmentSchema),
    repository: text,
    window: issuePickupReceiptSchema.properties.window,
    phase: Type.Union([
      Type.Literal('discovering'),
      Type.Literal('selecting'),
      Type.Literal('reserved'),
      Type.Literal('attempted'),
      Type.Literal('assigned'),
    ]),
    page: Type.Integer({ minimum: 1 }),
    scan: Type.Optional(
      Type.Object(
        { digest: text, projectIndex: time, skipped: Type.Optional(Type.Record(text, text)) },
        { additionalProperties: false },
      ),
    ),
    candidates: Type.Array(
      Type.Object(
        {
          ...pickupCandidateSchema.properties,
          repository: Type.Optional(text),
          repositoryNodeId: Type.Optional(text),
          milestoneNodeId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    discovery: Type.Optional(
      Type.Object(
        {
          pending: Type.Array(Type.Pick(pickupCandidateSchema, ['nodeId', 'number'])),
          nextPage: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    deferred: Type.Optional(
      Type.Array(
        Type.Object(
          {
            nodeId: text,
            number: Type.Integer({ minimum: 1 }),
            code: text,
            providerDiagnostic: Type.Optional(providerDiagnosticSchema),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    guidance: Type.Optional(Type.String({ maxLength: maximumAssessmentGuidanceBytes })),
    guidanceSource: Type.Optional(Type.Union([Type.Literal('inline'), Type.Literal('file')])),
    guidancePath: Type.Optional(text),
    selectionDigest: Type.Optional(text),
    selected: Type.Optional(
      Type.Object(
        {
          nodeId: text,
          number: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    shortlist: Type.Optional(Type.Array(text, { maxItems: 5 })),
    rationale: Type.Optional(text),
    beforeEvents: Type.Optional(Type.Array(text, { maxItems: 300 })),
    attemptedAt: Type.Optional(time),
    receipt: Type.Optional(issuePickupReceiptSchema),
    code: Type.Optional(text),
    providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  },
  { additionalProperties: false },
);
export const issuePickupStateSchema = Type.Object(
  {
    enrollment: issuePickupEnrollmentSchema,
    timezone: text,
    windowAssignment: Type.Optional(
      Type.Object(
        {
          ...assignmentFields,
        },
        { additionalProperties: false },
      ),
    ),
    charges: Type.Optional(Type.Array(chargeSchema)),
    operations: Type.Array(pickupOperationSchema),
  },
  { additionalProperties: false },
);
export type PickupOperation = Static<typeof pickupOperationSchema>;
export type IssuePickupState = Static<typeof issuePickupStateSchema>;
