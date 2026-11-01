import { Type, type Static } from 'typebox';

const time = Type.Integer({ minimum: 0 });
const text = Type.String({ minLength: 1, maxLength: 4096 });

export const assignmentObservationSchema = Type.Object(
  {
    missing: Type.Literal(true),
    observedAt: time,
    code: Type.Union([
      Type.Literal('assignment-removal-unapproved'),
      Type.Literal('assignment-removal-evidence-unavailable'),
      Type.Literal('assignment-removal-evidence-conflicting'),
      Type.Literal('assignment-removal-approved'),
    ]),
    event: Type.Optional(
      Type.Object(
        {
          nodeId: text,
          databaseId: time,
          createdAt: text,
          actor: Type.Object({ login: text, nodeId: text }, { additionalProperties: false }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AssignmentObservation = Static<typeof assignmentObservationSchema>;

export const retirementSchema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal('issue-closed'),
      Type.Literal('assignment-removed'),
      Type.Literal('chat-archived'),
      Type.Literal('operator-requested'),
    ]),
    at: time,
    intakeId: text,
    checkedAt: time,
    operatorRequest: Type.Optional(
      Type.Object(
        {
          caller: text,
          turnId: text,
          targetId: text,
          at: time,
          inputId: Type.Optional(text),
          sessionId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    reactivationAfter: Type.Optional(time),
    removalEventId: Type.Optional(text),
    eligibleAt: time,
    deadlinePending: Type.Optional(Type.Literal(true)),
    diagnostic: Type.Optional(text),
    activityId: Type.Optional(text),
    sessionUnavailableObserved: Type.Optional(
      Type.Object(
        {
          at: time,
          session: Type.Union([
            Type.Literal('not-found'),
            Type.Literal('identity-unresolved'),
            Type.Literal('access-denied'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    archivedAt: Type.Optional(time),
    archiveRequest: Type.Optional(
      Type.Object(
        { at: time, sessionId: text, code: Type.Optional(text) },
        { additionalProperties: false },
      ),
    ),
    archiveAttempt: Type.Optional(
      Type.Object(
        { at: time, turnId: text, sourceThreadId: Type.Optional(text) },
        { additionalProperties: false },
      ),
    ),
    worktreeRemovalObserved: Type.Optional(
      Type.Object(
        {
          at: time,
          source: Type.Union([
            Type.Literal('retirement-attempt'),
            Type.Literal('external-cleanup'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    worktreeRemovedAt: Type.Optional(time),
    worktreeRemovalAttemptedAt: Type.Optional(time),
    worktreeRemovalCode: Type.Optional(text),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type Retirement = Static<typeof retirementSchema>;

/** retirement removes scheduling eligibility immediately; the deadline only delays cleanup. */
export default function assignmentRetirement(input: {
  previous?: Retirement;
  reason?: Retirement['reason'];
  intakeId: string;
  now: number;
  graceMinutes?: number;
  activityId?: string;
  reactivate?: boolean;
  operatorRequest?: Retirement['operatorRequest'];
}): Retirement | undefined {
  if (input.reactivate) return undefined;
  if (!input.reason && !input.previous) return undefined;
  const previous = input.previous;
  const operatorRequest = previous?.operatorRequest ?? input.operatorRequest;
  const activity = Boolean(
    previous && input.activityId && previous.activityId !== input.activityId,
  );
  return {
    ...previous,
    reason: operatorRequest ? 'operator-requested' : (input.reason ?? previous!.reason),
    ...(operatorRequest ? { operatorRequest, reactivationAfter: operatorRequest.at } : {}),
    at: previous?.at ?? input.now,
    intakeId: previous?.intakeId ?? input.intakeId,
    checkedAt: input.now,
    ...(!operatorRequest && input.reason === 'issue-closed' && previous?.reason !== 'issue-closed'
      ? { reactivationAfter: input.now }
      : {}),
    eligibleAt: operatorRequest
      ? operatorRequest.at
      : !previous || activity || previous.deadlinePending
        ? input.graceMinutes === undefined
          ? (previous?.eligibleAt ?? input.now)
          : input.now + input.graceMinutes * 60_000
        : previous.eligibleAt,
    deadlinePending:
      !operatorRequest &&
      (!previous || activity || previous.deadlinePending) &&
      input.graceMinutes === undefined
        ? true
        : undefined,
    ...(input.activityId ? { activityId: input.activityId } : {}),
  };
}
