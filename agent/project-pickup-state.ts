import { projectCandidateSchema as pickupCandidateSchema } from '../channels/github/provider/project-pickup-client.ts';
import { Type, type Static } from 'typebox';

import {
  projectPickupEnrollmentSchema,
  projectPickupReceiptSchema,
} from './project-pickup-authority.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const pickupOperationSchema = Type.Object(
  {
    id: text,
    window: projectPickupReceiptSchema.properties.window,
    phase: Type.Union([
      Type.Literal('discovering'),
      Type.Literal('selecting'),
      Type.Literal('reserved'),
      Type.Literal('attempted'),
      Type.Literal('assigned'),
      Type.Literal('admitted'),
      Type.Literal('completed'),
      Type.Literal('empty'),
      Type.Literal('expired'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
    ]),
    page: Type.Integer({ minimum: 1 }),
    candidates: Type.Array(pickupCandidateSchema, { maxItems: 1000 }),
    guidance: Type.Optional(Type.String({ maxLength: 32000 })),
    selectionDigest: Type.Optional(text),
    selected: Type.Optional(pickupCandidateSchema),
    rationale: Type.Optional(text),
    beforeEvents: Type.Optional(Type.Array(text, { maxItems: 300 })),
    attemptedAt: Type.Optional(time),
    receipt: Type.Optional(projectPickupReceiptSchema),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const projectPickupStateSchema = Type.Object(
  {
    enrollment: projectPickupEnrollmentSchema,
    timezone: text,
    highWater: Type.Optional(time),
    operations: Type.Array(pickupOperationSchema),
  },
  { additionalProperties: false },
);
export type PickupCandidate = Static<typeof pickupCandidateSchema>;
export type PickupOperation = Static<typeof pickupOperationSchema>;
export type ProjectPickupState = Static<typeof projectPickupStateSchema>;

export function pickupUnfinished(operation: PickupOperation) {
  return !['completed', 'empty', 'expired', 'cancelled'].includes(operation.phase);
}
