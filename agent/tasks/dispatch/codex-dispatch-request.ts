import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { implementationMaterialSchema } from '../../../tools/dispatch/implementation-material-schema.ts';
import { nativeRetirementProperties } from '../../../tools/dispatch/retirement-schema.ts';
import { dispatchInspectionProperties } from './dispatch-inspection.ts';
import { issueChatTitleGuidance } from './issue-chat-title.ts';
import { assessmentSchema } from '../../model-routing.ts';

const id = Type.String({ pattern: '^[a-f0-9]{64}$' });
const digest = Type.Optional(Type.String());
const object = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });
const recovery = { id, digest };
const schemas = {
  inspect: object(dispatchInspectionProperties),
  'observe-denials': object({}),
  next: object({ projects: Type.Optional(Type.Unknown()), threads: Type.Optional(Type.Unknown()) }),
  report: object({ automationId: Type.String(), currentTimeIso: Type.String() }),
  handoff: object({ ...recovery, apply: Type.Optional(Type.Boolean()) }),
  reset: object({ ...recovery, apply: Type.Optional(Type.Boolean()) }),
  retire: Type.Union([
    object({
      ...recovery,
      apply: Type.Optional(Type.Boolean()),
      threads: Type.Optional(Type.Unknown()),
    }),
    object(nativeRetirementProperties),
  ]),
  recover: object({
    ...recovery,
    apply: Type.Optional(Type.Boolean()),
    pullRequest: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  'retry-denied': object({
    ...recovery,
    apply: Type.Optional(Type.Boolean()),
    renewAuthorization: Type.Optional(Type.Boolean()),
    approvedCallId: Type.Optional(Type.String({ pattern: '\\S' })),
  }),
  prepare: object({
    id,
    digest,
    assessment: assessmentSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 80,
      description: issueChatTitleGuidance,
      pattern: '^(?=.*\\S)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
    }),
    fallback: Type.Optional(Type.Literal('default')),
  }),
  reconcile: object({ id, receipt: Type.Optional(Type.Unknown()) }),
  context: object({ id, material: Type.Optional(implementationMaterialSchema) }),
};
export type DispatchAction = keyof typeof schemas;

/** Validate the command envelope once; resource and result validation remain with their owners. */
export default function validateDispatchRequest(
  action: string,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!Object.hasOwn(schemas, action)) throw new Error('dispatch-request-invalid');
  const schema = schemas[action as DispatchAction];
  const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (
    action !== 'inspect' &&
    (action === 'retire' || ('properties' in schema && Object.hasOwn(schema.properties, 'id'))) &&
    Object.hasOwn(request, 'id') &&
    !Value.Check(id, request.id)
  )
    throw new Error('dispatch-receipt-id-invalid');
  if (!Value.Check(schema, input)) throw new Error('dispatch-request-invalid');
}
