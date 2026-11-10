import { Type, type Static } from 'typebox';
const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
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
