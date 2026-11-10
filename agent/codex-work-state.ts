import { Type, type Static } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import type { CodexContinuationState } from './codex-continuation-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const codexWorkStateSchema = Type.Object(
  {
    scope: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('pull-request')])),
    blocked: Type.Optional(Type.Literal(true)),
    cancelled: Type.Optional(Type.Literal(true)),
    policyDigest: hash,
    selection: assessmentSelectionSchema,
    contextSelection: Type.Optional(assessmentSelectionSchema),
    binding: Type.Optional(workflowBindingSchema),
    activeTurnId: Type.Optional(text),
    blockedTurnId: Type.Optional(text),
    code: Type.Optional(text),
    policyHeld: Type.Optional(text),
    observation: Type.Optional(
      Type.Object(
        {
          turnId: text,
          afterItemId: text,
          receiptId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CodexWorkState = Static<typeof codexWorkStateSchema>;

/** legacy reads stay at this boundary while migrated tasks use native custody only. */
export default function codexWorkState(record: {
  nativeWork?: CodexWorkState;
  continuation?: CodexContinuationState;
}): (CodexWorkState & Partial<CodexContinuationState>) | undefined {
  return record.nativeWork ?? record.continuation;
}
