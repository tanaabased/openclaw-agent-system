import { deliveryBaseSchema } from '../../agent/delivery-base.ts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { implementationMaterialSchema } from './implementation-material-schema.ts';

import { implementationResultSchema } from '../../agent/implementation-result.ts';
import WorkflowRequestError from '../../agent/workflow-request-error.ts';

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
export const directImplementationRequestSchema = Type.Object(
  {
    action: Type.Literal('implementation'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('result'),
      Type.Literal('delivery'),
    ]),
    material: Type.Optional(implementationMaterialSchema),
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    deliveryOperation: Type.Optional(
      Type.Union([
        Type.Literal('prepare'),
        Type.Literal('publish'),
        Type.Literal('reconcile'),
        Type.Literal('present'),
      ]),
    ),
    base: Type.Optional(deliveryBaseSchema),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '\\S' })),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, pattern: '\\S' })),
    target: Type.Optional(text),
    path: Type.Optional(text),
    plan: Type.Optional(Type.String({ minLength: 1, maxLength: 64000, pattern: '\\S' })),
    result: Type.Optional(implementationResultSchema),
  },
  { additionalProperties: false },
);

/** validate the same envelope before either manual collection or managed routing. */
export function parseDirectImplementationRequest(input: unknown) {
  if (!Value.Check(directImplementationRequestSchema, input))
    throw invalidImplementationRequest(input);
  if (
    (input.material !== undefined &&
      (input.operation !== 'context' || input.scope !== undefined || input.plan !== undefined)) ||
    (input.result !== undefined && input.operation !== 'result') ||
    (input.operation === 'result' && !input.result) ||
    (input.operation === 'delivery' && !input.deliveryOperation) ||
    ((input.plan !== undefined || input.scope !== undefined) && input.operation !== 'context') ||
    (input.base !== undefined &&
      (input.operation !== 'delivery' ||
        !['prepare', 'publish'].includes(input.deliveryOperation ?? ''))) ||
    ((input.deliveryOperation || input.title || input.body) && input.operation !== 'delivery')
  )
    throw invalidImplementationRequest(input);
  return input;
}

export function invalidImplementationRequest(input: unknown) {
  const operation =
    input && typeof input === 'object' && 'operation' in input ? input.operation : undefined;
  const guidance =
    operation === 'context'
      ? 'use target and path for an explicit implementation context request, or omit the target when the native conversation has one verified owner. issue, checkout and worktree are not request fields. if verified implementation context is already supplied, use its implementation body without bootstrapping again.'
      : operation === 'result'
        ? 'put outcome, summary and fullResult inside result, not at the request root. outcome must be done, blocked or clarification-needed; clarification-needed also requires questions inside result. Result formatting stays in native context and is not a prerequisite for PR delivery.'
        : operation === 'delivery'
          ? 'supply deliveryOperation as prepare, publish, reconcile or present. Title, body and optional base belong at the request root. Do not include plan, scope or result.'
          : 'use action implementation with operation context, result or delivery.';
  return new WorkflowRequestError('implementation-request-invalid', guidance);
}
