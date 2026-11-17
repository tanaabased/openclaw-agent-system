import { Type } from 'typebox';

import { assessmentSchema, selectedProfileSchema } from '../../agent/models/model-routing.ts';
import { reviewDraftSchema } from '../../channels/github/provider/review-draft.ts';

/** authored choices only; native invocation selects ownership, credentials and retained effects. */
export const reviewRequestSchema = Type.Object(
  {
    action: Type.Literal('review'),
    operation: Type.Union([
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
