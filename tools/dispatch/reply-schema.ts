import { Type, type Static, type TSchema } from 'typebox';
import WorkflowRequestError from '../../agent/workflow-request-error.ts';
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
    privateText: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 32000,
        description:
          'Human-facing answer or verified facts for composition, not directions to the composer. Status updates display the resulting public card; present any additional private caveats directly in native chat.',
      }),
    ),
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
  if (!Value.Check(replyExecutionSchema, input)) throw invalidReplyRequest(input);
  if (input.update && (input.purpose !== 'status-update' || input.operation !== 'compose'))
    throw new WorkflowRequestError(
      'reply-request-invalid',
      'update requires purpose status-update and operation compose.',
    );
  if (input.operation === 'context' && input.purpose !== 'status-update')
    throw new WorkflowRequestError(
      'reply-request-invalid',
      'operation context requires purpose status-update; use compose for an authored reply.',
    );
  if (
    input.material &&
    (!['context', 'compose'].includes(input.operation) ||
      (input.privateText !== undefined && input.operation !== 'compose') ||
      input.outcome !== undefined ||
      input.update !== undefined)
  )
    throw new WorkflowRequestError(
      'reply-request-invalid',
      'forward the returned context or compose page request unchanged; do not combine material with outcome or update.',
    );
  return input;
}

export function invalidReplyRequest(input: unknown, schema: TSchema = replyExecutionSchema) {
  const error = Value.Errors(schema, input)[0];
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
  return new WorkflowRequestError('reply-request-invalid', `${field} ${expected}.${hint}`);
}
