import { Type } from 'typebox';
import {
  adoptedPullRequestSchema,
  deliveryContentUpdateSchema,
  deliveryPendingPushSchema,
  deliveryPullRequestSchema,
} from './delivery-state.ts';

import { assessmentSelectionSchema } from './assessment-selection.ts';
import { announcementRecoverySchema } from './delivery-announcement-recovery.ts';
import { deliveryAnnouncementStateSchema } from './delivery-announcement-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const input = Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false });
export const openclawWorkStateSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    code: Type.Optional(text),
    selection: Type.Optional(assessmentSelectionSchema),
    contextSelection: Type.Optional(assessmentSelectionSchema),
    implementation: Type.Optional(input),
    publication: Type.Optional(input),
    caller: Type.Optional(input),
    operatorInput: Type.Optional(input),
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
          body: Type.String({ maxLength: 65536 }),
          creationAttempted: Type.Boolean(),
          contentUpdate: Type.Optional(deliveryContentUpdateSchema),
          contentUpdateAttempted: Type.Optional(Type.Boolean()),
          pushedHead: Type.Optional(text),
          pendingPush: Type.Optional(deliveryPendingPushSchema),
          pullRequest: Type.Optional(deliveryPullRequestSchema),
          adopted: Type.Optional(adoptedPullRequestSchema),
          localBranch: Type.Optional(text),
          reconciled: Type.Boolean(),
          announcement: Type.Optional(deliveryAnnouncementStateSchema),
          announcementRecovery: Type.Optional(announcementRecoverySchema),
          presentation: Type.Optional(Type.String({ maxLength: 32000 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
