import { Type, type Static } from 'typebox';

import { codexFeedbackSchema } from './codex-feedback-state.ts';

import { codexContinuationStateSchema } from './codex-continuation-state.ts';
import { codexDeliveryStateSchema } from './codex-delivery-state.ts';
import DispatchStore, {
  dispatchRecordProperties,
  type DispatchState as SharedDispatchState,
} from './dispatch-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const dispatchProjectSchema = Type.Object(
  {
    id: text,
    path: text,
    commonDir: text,
    ref: text,
    commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
  },
  { additionalProperties: false },
);
export type DispatchProject = Static<typeof dispatchProjectSchema>;
const creationSchema = Type.Object(
  {
    title: text,
    prompt: Type.String({ minLength: 1, maxLength: 128000 }),
    model: text,
    thinking: text,
    target: Type.Object(
      {
        type: Type.Literal('project'),
        projectId: text,
        environment: Type.Object(
          {
            type: Type.Literal('worktree'),
            startingState: Type.Object(
              { type: Type.Literal('branch'), branchName: text },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const dispatchRecordSchema = Type.Object(
  {
    ...dispatchRecordProperties,
    reservationVersion: Type.Optional(Type.Literal(1)),
    capacityObservation: Type.Optional(
      Type.Object(
        {
          at: Type.Integer({ minimum: 0 }),
          code: text,
          threadId: Type.Optional(text),
          turnId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    issueMode: Type.Optional(
      Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
    ),
    project: Type.Optional(dispatchProjectSchema),
    repositoryPreparation: Type.Optional(
      Type.Object(
        {
          path: text,
          source: text,
          identity: text,
          checkout: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    request: Type.Optional(creationSchema),
    preparationTurnId: Type.Optional(text),
    unsubmittedCreations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            request: creationSchema,
            createdAt: Type.Integer({ minimum: 0 }),
            recoveredAt: Type.Integer({ minimum: 0 }),
            continuation: Type.Optional(codexContinuationStateSchema),
            turnId: text,
          },
          { additionalProperties: false },
        ),
        { maxItems: 8 },
      ),
    ),
    deniedCreations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            request: creationSchema,
            createdAt: Type.Integer({ minimum: 0 }),
            recoveredAt: Type.Integer({ minimum: 0 }),
            turnId: text,
            callId: text,
            approvedBy: Type.Optional(text),
          },
          { additionalProperties: false },
        ),
        { maxItems: 8 },
      ),
    ),
    clientThreadId: Type.Optional(text),
    receiptThreadId: Type.Optional(text),
    delivery: Type.Optional(codexDeliveryStateSchema),
    continuation: Type.Optional(codexContinuationStateSchema),
    feedback: Type.Optional(codexFeedbackSchema),
    renameRequested: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DispatchRecord = Static<typeof dispatchRecordSchema>;
export type DispatchState = SharedDispatchState<DispatchRecord>;

export default class CodexDispatchStore extends DispatchStore<DispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'codex',
      recordSchema: dispatchRecordSchema,
      validRecord: (record) => !record.request || Boolean(record.project),
    });
  }
}
