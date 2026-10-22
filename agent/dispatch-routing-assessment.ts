import { Value } from 'typebox/value';

import type { Complexity, RoutingField } from '../channels/github/provider/routing-metadata.ts';
import { assessmentSchema } from './model-routing.ts';

export default function dispatchRoutingAssessment(
  assessment: unknown,
  metadata?: RoutingField<Complexity> | null,
) {
  if (metadata?.status !== 'verified' || !Value.Check(assessmentSchema, assessment))
    return assessment;
  return {
    ...assessment,
    complexity: metadata.value,
    reason: `Verified ${metadata.source} Complexity: ${metadata.value}.`,
  };
}
