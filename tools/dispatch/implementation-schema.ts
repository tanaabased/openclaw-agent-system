import { implementationMaterialSchema } from './implementation-material-schema.ts';
import { Value } from 'typebox/value';
import { Type } from 'typebox';

import { implementationResultSchema } from '../../agent/implementation-result.ts';

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
export const directImplementationRequestSchema = Type.Object(
  {
    action: Type.Literal('implementation'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('result'),
      Type.Literal('present'),
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
    throw Object.assign(
      new Error(
        'implementation-request-invalid: use target and path for an explicit implementation context request, or omit the target when the native conversation has one verified owner. issue and checkout are not request fields. if verified implementation context is already supplied, use its implementation body without bootstrapping again.',
      ),
      { code: 'implementation-request-invalid' },
    );
  if (
    (input.material !== undefined &&
      (input.operation !== 'context' || input.scope !== undefined || input.plan !== undefined)) ||
    (input.result !== undefined && input.operation !== 'result') ||
    (input.operation === 'result' && !input.result) ||
    (input.operation === 'delivery' && !input.deliveryOperation) ||
    ((input.plan !== undefined || input.scope !== undefined) && input.operation !== 'context') ||
    ((input.deliveryOperation || input.title || input.body) && input.operation !== 'delivery')
  )
    throw new Error('implementation-request-invalid');
  return input;
}
