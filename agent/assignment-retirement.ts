import { Type, type Static } from 'typebox';

const time = Type.Integer({ minimum: 0 });
const text = Type.String({ minLength: 1, maxLength: 4096 });

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
    eligibleAt: time,
    activityId: Type.Optional(text),
    archivedAt: Type.Optional(time),
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
  graceMinutes: number;
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
    eligibleAt:
      !previous || activity ? input.now + input.graceMinutes * 60_000 : previous.eligibleAt,
    ...(input.activityId ? { activityId: input.activityId } : {}),
  };
}
