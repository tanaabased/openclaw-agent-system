import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { assessmentSummaryRequestProperties } from './assessment-summary-state.ts';
import { assessmentSchema } from './model-routing.ts';

const id = Type.String();
const digest = Type.Optional(Type.String());
const object = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });
const recovery = { id, digest };
const schemas = {
  inspect: object({}),
  'observe-denials': object({}),
  next: object({ projects: Type.Optional(Type.Unknown()), threads: Type.Optional(Type.Unknown()) }),
  report: object({ automationId: Type.String(), currentTimeIso: Type.String() }),
  handoff: object(recovery),
  reset: object(recovery),
  retire: object(recovery),
  'retry-denied': object({
    ...recovery,
    approvedCallId: Type.Optional(Type.String({ pattern: '\\S' })),
  }),
  prepare: object({
    id,
    digest,
    assessment: assessmentSchema,
    title: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 -]{2,79}$' }),
    fallback: Type.Optional(Type.Literal('default')),
  }),
  reconcile: object({ id, receipt: Type.Optional(Type.Unknown()) }),
  context: object({ id }),
  present: object({ id, includeDetails: Type.Optional(Type.Boolean()) }),
  summary: object({ id, ...assessmentSummaryRequestProperties }),
  result: object({
    id,
    result: Type.Optional(Type.Unknown()),
    previousResultDigest: Type.Optional(Type.String()),
  }),
};
export type DispatchAction = keyof typeof schemas;

/** Validate the command envelope once; resource and result validation remain with their owners. */
export default function validateDispatchRequest(
  action: string,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!Object.hasOwn(schemas, action) || !Value.Check(schemas[action as DispatchAction], input))
    throw new Error('dispatch-request-invalid');
}
