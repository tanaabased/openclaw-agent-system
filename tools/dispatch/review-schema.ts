import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentSchema, selectedProfileSchema } from '../../agent/models/model-routing.ts';
import { reviewDraftSchema } from '../../channels/github/provider/review-draft.ts';

/** authored choices only; native invocation selects ownership, credentials and retained effects. */
export const reviewRequestSchema = Type.Object(
  {
    action: Type.Literal('review'),
    operation: Type.Union([
      Type.Literal('check'),
      Type.Literal('scan'),
      Type.Literal('next'),
      Type.Literal('prepare'),
      Type.Literal('reconcile'),
      Type.Literal('context'),
      Type.Literal('publish'),
      Type.Literal('launch'),
      Type.Literal('retire'),
    ]),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    assessment: Type.Optional(assessmentSchema),
    overrides: Type.Optional(Type.Partial(selectedProfileSchema)),
    draft: Type.Optional(reviewDraftSchema),
  },
  { additionalProperties: false },
);

export function parseReviewRequest(authored: Record<string, unknown>) {
  type ReviewRequest = Static<typeof reviewRequestSchema>;
  if (!Value.Check(reviewRequestSchema, authored)) throw new Error('review-request-invalid');
  const input: ReviewRequest = authored;
  const allowed: Record<ReviewRequest['operation'], string[]> = {
    check: [],
    scan: [],
    next: ['target'],
    prepare: ['target', 'title', 'assessment', 'overrides'],
    reconcile: ['target'],
    context: [],
    publish: ['draft'],
    launch: ['target', 'overrides'],
    retire: ['target'],
  };
  if (
    Object.keys(authored).some(
      (key) => !['action', 'operation', ...allowed[input.operation]].includes(key),
    )
  )
    throw new Error('review-operation-arguments-invalid');
  return input;
}
