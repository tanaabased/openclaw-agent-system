import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { implementationMaterialSchema } from './implementation-material-schema.ts';

import { maximumGitHubNotificationReplyLength } from '../../channels/github/publication/limits.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const statusUpdateSchema = Type.Object(
  {
    observation: hash,
    facts: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 256 }),
          reference: Type.String({ minLength: 1, maxLength: 2048 }),
          revision: Type.String({ minLength: 1, maxLength: 256 }),
          text: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export type StatusUpdate = Static<typeof statusUpdateSchema>;
/** execution input includes runtime-bound material versions; the public tool schema removes them. */
export const replyExecutionSchema = Type.Object(
  {
    action: Type.Literal('reply'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('compose'),
      Type.Literal('candidate'),
      Type.Literal('publish'),
      Type.Literal('reconcile'),
    ]),
    purpose: Type.Optional(Type.Literal('status-update')),
    material: Type.Optional(implementationMaterialSchema),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    privateText: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
    outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
    publicText: Type.Optional(
      Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
    ),
    update: Type.Optional(
      Type.Object(
        {
          facts: Type.Array(
            Type.Object(
              {
                reference: Type.String({ minLength: 1, maxLength: 2048 }),
                text: Type.String({ minLength: 1, maxLength: 4000 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 20 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ReplyExecutionRequest = Static<typeof replyExecutionSchema>;

/** describe schema-owned fields without echoing authored values or unknown property names. */
export function parseReplyRequest(input: unknown): ReplyExecutionRequest {
  if (Value.Check(replyExecutionSchema, input)) return input;
  const error = Value.Errors(replyExecutionSchema, input)[0];
  const field = ['request', ...(error?.instancePath.split('/').filter(Boolean) ?? [])].join('.');
  const expected =
    error?.keyword === 'type'
      ? `must be ${String(error.params.type)}`
      : error?.keyword === 'additionalProperties'
        ? 'contains unsupported fields; omit runtime-owned IDs, digests and receipts'
        : 'must match the reply request schema';
  const hint =
    field === 'request.outcome'
      ? ' outcome is optional authored text; omit it when privateText already describes the result.'
      : '';
  throw Object.assign(new Error(`reply-request-invalid: ${field} ${expected}.${hint}`), {
    code: 'reply-request-invalid',
  });
}
