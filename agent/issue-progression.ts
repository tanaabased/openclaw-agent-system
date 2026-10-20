import { Type, type Static } from 'typebox';

import { assessmentDecisionMode } from './assessment-result.ts';

export const issueProgressionSchema = Type.Object(
  {
    stage: Type.Literal('implementation'),
    via: Type.Union([
      Type.Literal('work'),
      Type.Literal('auto'),
      Type.Literal('operator'),
      Type.Literal('legacy'),
    ]),
    workOwner: Type.Optional(
      Type.Union([Type.Literal('issue'), Type.String({ pattern: '^[a-f0-9]{64}$' })]),
    ),
    enteredAt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type IssueProgression = Static<typeof issueProgressionSchema>;
interface Issue {
  progression?: IssueProgression;
  createdAt: number;
  retired?: unknown;
  retirement?: unknown;
  reset?: unknown;
  handoff?: unknown;
  result?: {
    outcome: string;
    decision?: { mode: 'plan' | 'work' } | { action: 'wait' | 'proceed' };
  };
  continuation?: {
    phase?: string;
    runId?: string;
    attempt?: unknown;
    binding?: unknown;
    result?: unknown;
  };
  work?: { implementation?: unknown };
}

/** recover stage from execution receipts, never from a default mode or a plan alone. */
export function retainedIssueProgression(issue: Issue): IssueProgression | undefined {
  return (
    issue.progression ??
    (issue.continuation?.attempt ||
    issue.continuation?.binding ||
    issue.continuation?.result ||
    issue.work?.implementation
      ? { stage: 'implementation', via: 'legacy' }
      : undefined)
  );
}

/** mode governs entry once; lifecycle stops remain independent of the retained stage. */
export default function issueProgression(
  issue: Issue,
  input: { mode: 'plan' | 'work' | 'auto'; now: number; operator?: boolean },
):
  | { status: 'ready'; progression: IssueProgression }
  | { status: 'held'; reason: string }
  | { status: 'stopped'; reason: string } {
  if (issue.retired || issue.retirement || issue.reset)
    return { status: 'stopped', reason: 'issue-inactive' };
  if (issue.continuation?.phase === 'cancelled' && !issue.handoff)
    return { status: 'stopped', reason: 'implementation-cancelled' };
  const retained = retainedIssueProgression(issue);
  if (retained) return { status: 'ready', progression: retained };
  if (issue.result?.outcome !== 'plan-ready')
    return { status: 'held', reason: 'assessment-not-actionable' };
  if (!input.operator) {
    if (input.mode === 'plan') return { status: 'held', reason: 'implementation-disabled' };
    if (input.mode === 'auto' && assessmentDecisionMode(issue.result.decision) !== 'work')
      return {
        status: 'held',
        reason: issue.result.decision ? 'auto-wait' : 'auto-decision-required',
      };
  }
  return {
    status: 'ready',
    progression: {
      stage: 'implementation',
      via: input.operator ? 'operator' : input.mode === 'work' ? 'work' : 'auto',
      enteredAt: input.now,
    },
  };
}
