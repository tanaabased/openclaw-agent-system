import { Value } from 'typebox/value';
import { Type } from 'typebox';

import { implementationResultSchema } from '../../agent/implementation-result.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
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
    id: Type.Optional(hash),
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
    digest: Type.Optional(hash),
    target: Type.Optional(text),
    path: Type.Optional(text),
    plan: Type.Optional(Type.String({ minLength: 1, maxLength: 64000, pattern: '\\S' })),
    result: Type.Optional(implementationResultSchema),
  },
  { additionalProperties: false },
);

/** validate the same envelope before either manual collection or managed routing. */
export function parseDirectImplementationRequest(input: unknown) {
  if (
    !Value.Check(directImplementationRequestSchema, input) ||
    (input.result !== undefined && input.operation !== 'result') ||
    (input.operation === 'result' && !input.result) ||
    (input.operation === 'delivery' && !input.deliveryOperation) ||
    ((input.plan !== undefined || input.scope !== undefined) && input.operation !== 'context') ||
    ((input.deliveryOperation || input.title || input.body || input.digest) &&
      input.operation !== 'delivery') ||
    (input.operation !== 'context' && !input.id)
  )
    throw new Error('implementation-request-invalid');
  return input;
}
