import { Type, type Static } from 'typebox';
import { automationHash } from './automation-hash.ts';
import {
  checkRetainedCount,
  packRetained,
  retainedEvidenceSchema,
  retainedHistoryLimit,
} from './retained-history.ts';

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
    completed: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type OpenClawIntakePass = Static<typeof openclawIntakePassSchema>;

export const openclawPassHistorySchema = Type.Array(
  Type.Object(
    {
      id: hash,
      sessionKey: text,
      sessionId: text,
      runId: text,
      evidence: retainedEvidenceSchema,
    },
    { additionalProperties: false },
  ),
  { maxItems: retainedHistoryLimit },
);

export function compactIntakePasses(state: {
  openclawPasses?: OpenClawIntakePass[];
  openclawPassHistory?: Static<typeof openclawPassHistorySchema>;
}) {
  const completed = state.openclawPasses?.filter((pass) => pass.completed) ?? [];
  if (!completed.length) return;
  const history = [...(state.openclawPassHistory ?? [])];
  checkRetainedCount(
    history.length + completed.length,
    'openclaw-intake-passes',
    completed[0]!.runId,
  );
  for (const pass of completed) {
    const { sessionKey, sessionId, runId } = pass;
    const id = automationHash([sessionKey, sessionId, runId]);
    history.push({ id, sessionKey, sessionId, runId, evidence: packRetained(pass, id) });
  }
  state.openclawPassHistory = history;
  state.openclawPasses = state.openclawPasses!.filter((pass) => !pass.completed);
}

export function sameIntakeRun(
  pass: Pick<OpenClawIntakePass, 'sessionKey' | 'sessionId' | 'runId'>,
  caller: { sessionKey: string; sessionId: string; runId: string },
) {
  return (
    pass.sessionKey === caller.sessionKey &&
    pass.sessionId === caller.sessionId &&
    pass.runId === caller.runId
  );
}
