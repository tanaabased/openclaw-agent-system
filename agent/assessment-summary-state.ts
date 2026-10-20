import { Type, type Static, type TObject } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const assessmentSummaryRequestProperties = {
  operation: Type.Union([
    Type.Literal('compose'),
    Type.Literal('candidate'),
    Type.Literal('publish'),
    Type.Literal('reconcile'),
  ]),
  digest: Type.Optional(hash),
  publicText: Type.Optional(
    Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
  ),
};
export const assessmentSummarySchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    resultDigest: hash,
    binding: workflowBindingSchema,
    turnId: text,
    authorityDigest: hash,
    selection: assessmentSelectionSchema,
    authorLogin: Type.Optional(text),
    publicText: Type.Optional(
      Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
    ),
    attempt: Type.Optional(text),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type AssessmentSummary = Static<typeof assessmentSummarySchema>;
export type AssessmentSummaryRequest = Static<TObject<typeof assessmentSummaryRequestProperties>>;

/** Consent is part of the saved native definition; an older schedule cannot inherit this effect. */
export const assessmentSummaryConsent =
  'Assessment-summary authorization: activating this workflow authorizes one concise public issue summary per deliberately revised retained assessment, after the complete assessment is presented in its owning chat. Use only the assessment-summary operation and its verified issue and draft. Preserve the configured voice and explain the user journey, proposed change and expected outcome. No per-summary human confirmation is required; native approval review remains in force and a denial stops publication. This grants no implementation, review, or unrelated GitHub action.';

export function assessmentSummaryInstructions(runtime: 'codex' | 'openclaw') {
  return `First reproduce the complete recorded private review presentation in this chat. Then call ${runtime === 'codex' ? 'dispatchRuntime action:summary' : 'agent_system_dispatch action summary'}, operation compose with this id. Read the returned voice-aware reply skill and compose a separate concise user-journey summary. Follow candidate and publication instructions. A summary failure leaves the assessment recorded: show its diagnostic, preserve the private review here and the full assessment in saved context, and stop on native denial. Never publish the private plan or invent an incoming comment.`;
}
