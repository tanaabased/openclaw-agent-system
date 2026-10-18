import { Type, type Static } from 'typebox';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });

/** native run identity, not the persistent coordinator conversation, bounds an intake pass. */
export const openclawIntakePassSchema = Type.Object(
  {
    sessionKey: text,
    sessionId: text,
    runId: text,
    limit: Type.Integer({ minimum: 1 }),
    allowance: Type.Integer({ minimum: 0 }),
    candidates: Type.Array(hash, { uniqueItems: true }),
    recovery: Type.Array(hash, { uniqueItems: true }),
    selected: Type.Array(hash, { uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type OpenClawIntakePass = Static<typeof openclawIntakePassSchema>;

export function sameIntakeRun(
  pass: OpenClawIntakePass,
  caller: { sessionKey: string; sessionId: string; runId: string },
) {
  return (
    pass.sessionKey === caller.sessionKey &&
    pass.sessionId === caller.sessionId &&
    pass.runId === caller.runId
  );
}
