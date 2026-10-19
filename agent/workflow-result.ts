import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentResultSchema, parseAssessmentResult } from './assessment-result.ts';
import { automationHash } from './automation-hash.ts';
import { stageResultContracts, type WorkflowStage } from './workflow-stage.ts';

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const summary = Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' });
export const workflowBindingSchema = Type.Object(
  {
    admissionId: text,
    workflow: Type.Union([Type.Literal('issue-assignment'), Type.Literal('review-request')]),
    repositoryId: text,
    subjectId: text,
    threadId: text,
    turnId: text,
    worktree: text,
    dispatchDigest: hash,
    policyDigest: hash,
    selectionDigest: hash,
    routingDigest: hash,
    evidenceDigest: hash,
  },
  { additionalProperties: false },
);
export type WorkflowBinding = Static<typeof workflowBindingSchema>;

const common = { version: Type.Literal(1), binding: workflowBindingSchema };
/** internal workflow output, not an interface that replacement skill authors must implement. */
export const workflowResultSchema = Type.Union([
  Type.Object(
    {
      ...common,
      stage: Type.Literal('assessment'),
      resultContract: Type.Literal(stageResultContracts.assessment),
      result: assessmentResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      stage: Type.Literal('implementation'),
      resultContract: Type.Literal(stageResultContracts.implementation),
      result: Type.Object(
        {
          outcome: Type.Union([
            Type.Literal('done'),
            Type.Literal('blocked'),
            Type.Literal('clarification-needed'),
          ]),
          summary,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      stage: Type.Literal('review'),
      resultContract: Type.Literal(stageResultContracts.review),
      result: Type.Object(
        {
          outcome: Type.Union([
            Type.Literal('continue'),
            Type.Literal('wait'),
            Type.Literal('done'),
            Type.Literal('blocked'),
          ]),
          summary,
          publicationCandidates: Type.Array(text, { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type WorkflowResult = Static<typeof workflowResultSchema>;

/** callers supply independently verified current binding; model results cannot supply authority. */
export function validateWorkflowResult(
  value: unknown,
  expected: { binding: WorkflowBinding; stage: WorkflowStage; authorized: boolean },
): WorkflowResult {
  if (!expected.authorized) throw new Error('workflow-authority-lost');
  if (!Value.Check(workflowResultSchema, value) || JSON.stringify(value).length > 128000)
    throw new Error('workflow-result-invalid');
  if (
    !Value.Check(workflowBindingSchema, expected.binding) ||
    automationHash(value.binding) !== automationHash(expected.binding)
  )
    throw new Error('workflow-result-stale');
  if (
    value.stage !== expected.stage ||
    (value.stage === 'review') !== (value.binding.workflow === 'review-request')
  )
    throw new Error('workflow-stage-mismatch');
  if (value.stage === 'assessment') parseAssessmentResult(value.result);
  return value;
}

export interface WorkflowScheduleAuthority {
  version: 1;
  workflow: 'issue-assignment' | 'review-request';
  automationId: string;
  sourceThreadId: string;
  policyDigest: string;
  definitionDigest: string;
  capabilities: Array<WorkflowStage | 'publication' | 'feedback' | 'assessment-summary'>;
}

/** only a freshly reconciled native definition can authorize a new stage or publication. */
export function requireWorkflowSchedule(
  saved: WorkflowScheduleAuthority | undefined,
  current: Omit<WorkflowScheduleAuthority, 'version' | 'capabilities'>,
  capability: WorkflowStage | 'publication' | 'feedback' | 'assessment-summary',
): void {
  if (
    !saved ||
    saved.version !== 1 ||
    !saved.capabilities.includes(capability) ||
    !current.automationId ||
    !current.sourceThreadId ||
    saved.automationId !== current.automationId ||
    saved.workflow !== current.workflow ||
    (capability !== 'publication' &&
      capability !== 'feedback' &&
      (capability === 'review') !== (current.workflow === 'review-request')) ||
    saved.sourceThreadId !== current.sourceThreadId
  )
    throw new Error('workflow-schedule-reconciliation-required');
}

export interface WorkflowPublicationReceipt {
  candidateId: string;
  bindingDigest: string;
  status: 'pending' | 'uncertain' | 'published';
  providerId?: string;
  url?: string;
}

/** a lost publication response requires provider reconciliation, never another blind write. */
export function publicationDisposition(
  receipt: WorkflowPublicationReceipt | undefined,
  candidateId: string,
  binding: WorkflowBinding,
): 'prepare' | 'reconcile' | 'published' {
  if (!receipt) return 'prepare';
  if (receipt.candidateId !== candidateId || receipt.bindingDigest !== automationHash(binding))
    throw new Error('workflow-publication-binding-mismatch');
  if (receipt.status !== 'published') return 'reconcile';
  if (!receipt.providerId || !receipt.url) throw new Error('workflow-publication-receipt-invalid');
  return 'published';
}
