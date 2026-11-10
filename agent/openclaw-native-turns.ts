import { Type, type Static } from 'typebox';
import { issueTurnSchema } from './openclaw-turn-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

export const nativeTurnSchema = Type.Object(
  {
    role: Type.Union([
      Type.Literal('first'),
      Type.Literal('assessment'),
      Type.Literal('decision'),
      Type.Literal('summary'),
      Type.Literal('implementation'),
      Type.Literal('delivery'),
      Type.Literal('feedback'),
    ]),
    turn: Type.Object(
      {
        ...Type.Omit(issueTurnSchema, ['message', 'executionModel']).properties,
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
    ...(
      [
        ['first', record.firstTurn],
        ['assessment', record.assessmentTurn],
        ['decision', record.decisionTurn],
        ['summary', record.summaryRecovery?.turn],
        ['implementation', record.work?.turn],
        ['delivery', record.work?.deliveryTurn],
        ...(record.previousDecisionTurns ?? []).map((turn) => ['decision', turn]),
        ...(record.previousSummaryTurns ?? []).map(({ turn }) => ['summary', turn]),
        ...(record.work?.previousTurns ?? []).map(({ slot, turn }) => [
          slot === 'turn' ? 'implementation' : 'delivery',
          turn,
        ]),
        ...(record.feedback?.events ?? []).flatMap((event) => [
          ['feedback', event.turn],
          ...(event.ownerResumptions ?? []).map(({ previousTurn }) => ['feedback', previousTurn]),
        ]),
      ] as Array<[NativeTurn['role'], NativeTurn['turn'] | undefined]>
    ).flatMap(([role, turn]) => (turn ? [{ role, turn }] : [])),
  ];
}

export function nativeTurnFor(record: OpenClawDispatchRecord, role: NativeTurn['role']) {
  return openClawNativeTurns(record).findLast((entry) => entry.role === role)?.turn;
}
