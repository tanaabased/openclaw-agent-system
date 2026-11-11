import { Type, type Static } from 'typebox';
import { assessmentDecisionMode } from './assessment-result.ts';
export const issueProgressionSchema = Type.Object(
  {
    stage: Type.Literal('implementation'),
    via: Type.Union([Type.Literal('work'), Type.Literal('auto'), Type.Literal('operator')]),
  },
  { additionalProperties: false },
);
export type IssueProgression = Static<typeof issueProgressionSchema>;
export const implementationDecisionSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('plan'), Type.Literal('work')]),
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
      minItems: 1,
      maxItems: 10,
    }),
  },
  { additionalProperties: false },
);
interface Issue {
  implementationDecision?: Static<typeof implementationDecisionSchema>;
  progression?: IssueProgression;
  retirement?: unknown;
  reset?: unknown;
  handoff?: unknown;
  nativeWork?: {
    cancelled?: true;
  };
}
/** current workflows retain their explicit implementation transition. */
export function retainedIssueProgression(issue: Issue): IssueProgression | undefined {
  return issue.progression;
}
/** mode governs entry once; lifecycle stops remain independent of the retained stage. */
export default function issueProgression(
  issue: Issue,
  input: {
    mode: 'plan' | 'work' | 'auto';
    operator?: boolean;
    decision?: Static<typeof implementationDecisionSchema>;
  },
):
  | {
      status: 'ready';
      progression: IssueProgression;
    }
  | {
      status: 'held';
      reason: string;
    }
  | {
      status: 'stopped';
      reason: string;
    } {
  if (issue.retirement || issue.reset) return { status: 'stopped', reason: 'issue-inactive' };
  if (issue.nativeWork?.cancelled && !issue.handoff && !input.operator)
    return { status: 'stopped', reason: 'implementation-cancelled' };
  const retained = retainedIssueProgression(issue);
  if (retained) return { status: 'ready', progression: retained };
  if (!input.operator) {
    if (input.mode === 'plan') return { status: 'held', reason: 'implementation-disabled' };
    const decision = input.decision ?? issue.implementationDecision;
    if (input.mode === 'auto' && assessmentDecisionMode(decision) !== 'work')
      return {
        status: 'held',
        reason: decision ? 'auto-wait' : 'auto-decision-required',
      };
  }
  return {
    status: 'ready',
    progression: {
      stage: 'implementation',
      via: input.operator ? 'operator' : input.mode === 'work' ? 'work' : 'auto',
    },
  };
}
