import { Type, type Static } from 'typebox';
import type { OpenClawDispatchRecord } from './tasks/dispatch/openclaw-dispatch-state.ts';
import { issueTurnSchema } from './openclaw-turn-state.ts';

export const nativeTurnSchema = Type.Object(
  {
    role: Type.Union([Type.Literal('assessment'), Type.Literal('feedback')]),
    turn: Type.Object(
      {
        ...Type.Omit(issueTurnSchema, ['message']).properties,
        message: Type.Optional(issueTurnSchema.properties.message),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type NativeTurn = Static<typeof nativeTurnSchema>;

export default function openClawNativeTurns(record: OpenClawDispatchRecord): NativeTurn[] {
  return [
    ...(record.nativeTurns ?? []),
    ...(record.feedback?.events ?? []).flatMap((event) =>
      event.turn ? [{ role: 'feedback' as const, turn: event.turn }] : [],
    ),
  ];
}

export function nativeTurnFor(record: OpenClawDispatchRecord, role: NativeTurn['role']) {
  return openClawNativeTurns(record).findLast((entry) => entry.role === role)?.turn;
}
