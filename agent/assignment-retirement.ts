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
    ]),
    at: time,
    intakeId: text,
    checkedAt: time,
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
    archiveAttempt: Type.Optional(
      Type.Object({ at: time, turnId: text }, { additionalProperties: false }),
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
}): Retirement | undefined {
  if (input.reactivate) return undefined;
  if (!input.reason && !input.previous) return undefined;
  const previous = input.previous;
  const activity = Boolean(
    previous && input.activityId && previous.activityId !== input.activityId,
  );
  return {
    ...previous,
    reason: input.reason ?? previous!.reason,
    at: previous?.at ?? input.now,
    intakeId: previous?.intakeId ?? input.intakeId,
    checkedAt: input.now,
    ...(input.reason === 'issue-closed' && previous?.reason !== 'issue-closed'
      ? { reactivationAfter: input.now }
      : {}),
    eligibleAt:
      !previous || activity || previous.deadlinePending
        ? input.graceMinutes === undefined
          ? (previous?.eligibleAt ?? input.now)
          : input.now + input.graceMinutes * 60_000
        : previous.eligibleAt,
    deadlinePending:
      (!previous || activity || previous.deadlinePending) && input.graceMinutes === undefined
        ? true
        : undefined,
    ...(input.activityId ? { activityId: input.activityId } : {}),
  };
}

/** historical terminal status alone does not prove that resources were reclaimed. */
export function unverifiedLegacyRetirement(record: {
  retired?: unknown;
  retirement?: Retirement;
}): boolean {
  return Boolean(
    record.retired &&
    (record.retirement?.worktreeRemovedAt === undefined ||
      (record.retirement.archivedAt === undefined &&
        !record.retirement.sessionUnavailableObserved)),
  );
}
