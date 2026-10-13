import { Type, type Static } from 'typebox';

import DispatchStore, { dispatchRecordProperties, type DispatchState } from './dispatch-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const openclawCreationSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 128000 }),
    label: text,
    cwd: text,
    model: text,
    runtime: Type.Literal('subagent'),
    visible: Type.Literal(true),
    cleanup: Type.Literal('keep'),
    group: Type.Optional(text),
    expectsCompletionMessage: Type.Optional(Type.Literal(false)),
  },
  { additionalProperties: false },
);
export const openclawDispatchRecordSchema = Type.Object(
  {
    ...dispatchRecordProperties,
    request: Type.Optional(openclawCreationSchema),
    creationCall: Type.Optional(
      Type.Object(
        {
          runId: text,
          sessionId: text,
          toolCallId: text,
        },
        { additionalProperties: false },
      ),
    ),
    blocker: Type.Optional(text),
    setupComplete: Type.Optional(Type.Boolean()),
    setupObservation: Type.Optional(
      Type.Object(
        {
          sessionKey: text,
          sessionId: text,
          runId: text,
          success: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    continuation: Type.Optional(
      Type.Object(
        {
          message: text,
          issuedAt: Type.Integer({ minimum: 0 }),
          runId: Type.Optional(text),
          toolCallId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    execution: Type.Optional(
      Type.Object(
        {
          runId: text,
          model: text,
          effort: text,
        },
        { additionalProperties: false },
      ),
    ),
    native: Type.Optional(
      Type.Object(
        {
          sessionKey: text,
          sessionId: text,
          runId: text,
          sourceSessionId: text,
          toolCallId: text,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type OpenClawDispatchRecord = Static<typeof openclawDispatchRecordSchema>;
export type OpenClawDispatchState = DispatchState<OpenClawDispatchRecord>;

export default class OpenClawDispatchStore extends DispatchStore<OpenClawDispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'openclaw',
      recordSchema: openclawDispatchRecordSchema,
      validRecord: (record) =>
        (!record.request || record.worktree === record.request.cwd) &&
        (!record.creationCall || Boolean(record.request)) &&
        (!record.native ||
          Boolean(
            record.request &&
            record.creationCall &&
            record.threadId === record.native.sessionKey &&
            record.creationCall.sessionId === record.native.sourceSessionId &&
            record.creationCall.toolCallId === record.native.toolCallId,
          )) &&
        (!record.setupComplete ||
          Boolean(
            record.native &&
            record.setupObservation?.success &&
            record.setupObservation.sessionKey === record.native.sessionKey &&
            record.setupObservation.sessionId === record.native.sessionId &&
            record.setupObservation.runId === record.native.runId,
          )) &&
        (!record.continuation || Boolean(record.setupComplete && record.effective)) &&
        (!record.execution || Boolean(record.continuation?.runId && record.effective)) &&
        (!record.effective || Boolean(record.native && record.effective.status === 'verified')) &&
        (!['assessing', 'complete'].includes(record.phase) ||
          Boolean(
            record.native && record.effective && record.setupComplete && record.continuation,
          )),
    });
  }
}
