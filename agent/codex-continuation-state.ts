import { Type, type Static } from 'typebox';

import { implementationResultSchema } from './implementation-result.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { workflowBindingSchema } from './workflow-result.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const attemptSchema = Type.Object(
  {
    id: hash,
    sourceTurnId: text,
    beforeTurnId: text,
    request: Type.Object(
      {
        threadId: text,
        prompt: Type.String({ minLength: 1, maxLength: 32000 }),
        model: text,
        thinking: text,
      },
      { additionalProperties: false },
    ),
    turnId: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const codexContinuationStateSchema = Type.Object(
  {
    phase: Type.Union([
      Type.Literal('waiting'),
      Type.Literal('prepared'),
      Type.Literal('running'),
      Type.Literal('delivery'),
      Type.Literal('complete'),
      Type.Literal('blocked'),
      Type.Literal('cancelled'),
    ]),
    retry: Type.Optional(
      Type.Object(
        { code: text, attempts: Type.Integer({ minimum: 1, maximum: 5 }) },
        { additionalProperties: false },
      ),
    ),
    retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
    policyDigest: hash,
    policyHeld: Type.Optional(text),
    activeTurnId: Type.Optional(text),
    selection: assessmentSelectionSchema,
    assessmentDigest: Type.Optional(hash),
    assessmentSelectionDigest: Type.Optional(hash),
    attempt: Type.Optional(attemptSchema),
    retries: Type.Optional(
      Type.Array(
        Type.Object(
          {
            attempt: attemptSchema,
            binding: Type.Optional(workflowBindingSchema),
            resumeAfterTurnId: Type.Optional(text),
            rejection: Type.Optional(
              Type.Object(
                {
                  callId: text,
                  requestDigest: hash,
                  reason: Type.String({ minLength: 1, maxLength: 32000 }),
                },
                { additionalProperties: false },
              ),
            ),
            mismatch: Type.Optional(
              Type.Object(
                {
                  callId: text,
                  requestDigest: hash,
                  turnId: text,
                },
                { additionalProperties: false },
              ),
            ),
            at: Type.Integer({ minimum: 0 }),
            by: text,
          },
          { additionalProperties: false },
        ),
        { maxItems: 8 },
      ),
    ),
    publicationAttempt: Type.Optional(attemptSchema),
    binding: Type.Optional(workflowBindingSchema),
    result: Type.Optional(implementationResultSchema),
    head: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type CodexContinuationState = Static<typeof codexContinuationStateSchema>;
