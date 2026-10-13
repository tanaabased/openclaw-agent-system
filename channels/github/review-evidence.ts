import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from '../../agent/automation-hash.ts';

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' });
const revision = Type.Object({ id: text, revision: text }, { additionalProperties: false });
export const reviewEvidenceSchema = Type.Object(
  {
    head: text,
    base: text,
    complete: Type.Boolean(),
    checks: Type.Array(
      Type.Object(
        {
          id: text,
          attempt: Type.Integer({ minimum: 1 }),
          status: text,
          conclusion: Type.Union([text, Type.Null()]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
    feedback: Type.Array(revision, { maxItems: 1000 }),
    requests: Type.Array(revision, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
export type ReviewEvidence = Static<typeof reviewEvidenceSchema>;

/** identities come from complete provider reads and already-admitted feedback, never prose. */
export function reviewEvidenceDigest(value: ReviewEvidence): string {
  if (!Value.Check(reviewEvidenceSchema, value)) throw new Error('review-evidence-invalid');
  const ordered = <T extends { id: string }>(entries: T[]) => {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('review-evidence-duplicate');
    return [...entries].sort((a, b) => a.id.localeCompare(b.id));
  };
  return automationHash({
    ...value,
    checks: ordered(value.checks),
    feedback: ordered(value.feedback),
    requests: ordered(value.requests),
  });
}

/** done is revision-scoped; provider closure and lost authority are separate stop reasons. */
export function reviewTrigger(input: {
  current: ReviewEvidence;
  processedDigest?: string;
  running: boolean;
  open: boolean;
  authorized: boolean;
}): 'closed' | 'unauthorized' | 'evidence-unavailable' | 'unchanged' | 'pending' | 'dispatch' {
  if (!input.authorized) return 'unauthorized';
  if (!input.open) return 'closed';
  const digest = reviewEvidenceDigest(input.current);
  if (!input.current.complete) return 'evidence-unavailable';
  if (digest === input.processedDigest) return 'unchanged';
  return input.running ? 'pending' : 'dispatch';
}
