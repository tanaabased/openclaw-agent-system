import {
  deliveryContentUpdateSchema,
  deliveryPendingPushSchema,
  deliveryPullRequestSchema,
} from './delivery-state.ts';
import { Type } from 'typebox';

import { issueTurnSchema } from './openclaw-turn-state.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { implementationResultSchema } from './implementation-result.ts';
import { deliveryAnnouncementStateSchema } from './delivery-announcement-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const input = Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false });
export const openclawWorkStateSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    assessmentDigest: hash,
    turn: Type.Optional(issueTurnSchema),
    previousTurns: Type.Optional(
      Type.Array(
        Type.Object(
          {
            slot: Type.Union([Type.Literal('turn'), Type.Literal('deliveryTurn')]),
            turn: issueTurnSchema,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    deliveryTurn: Type.Optional(issueTurnSchema),
    code: Type.Optional(text),
    selection: Type.Optional(assessmentSelectionSchema),
    implementation: Type.Optional(input),
    publication: Type.Optional(input),
    caller: Type.Optional(input),
    clarificationInput: Type.Optional(input),
    operatorInput: Type.Optional(input),
    result: Type.Optional(implementationResultSchema),
    delivery: Type.Optional(
      Type.Object(
        {
          id: hash,
          binding: Type.Object(
            {
              repositoryId: text,
              issueId: text,
              sessionId: text,
              threadId: text,
              worktree: text,
              branch: text,
              base: text,
              head: text,
              authorId: text,
              policyDigest: hash,
            },
            { additionalProperties: false },
          ),
          title: Type.String({ minLength: 1, maxLength: 512 }),
          body: Type.String({ minLength: 1, maxLength: 65536 }),
          creationAttempted: Type.Boolean(),
          contentUpdate: Type.Optional(deliveryContentUpdateSchema),
          pushedHead: Type.Optional(text),
          pendingPush: Type.Optional(deliveryPendingPushSchema),
          pullRequest: Type.Optional(deliveryPullRequestSchema),
          reconciled: Type.Boolean(),
          announcement: Type.Optional(deliveryAnnouncementStateSchema),
          presentation: Type.Optional(Type.String({ maxLength: 32000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
