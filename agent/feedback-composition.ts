import type { Static } from 'typebox';

import type { assessmentSelectionSchema } from './assessment-selection.ts';
import type { ImplementationResult } from './implementation-result.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

/** retain reply facts without forwarding implementation methods or saved result transcripts. */
export function feedbackOutcome(input: {
  implementation?: ImplementationResult;
  head?: string;
  delivery?: { pullRequestNodeId: string; pullRequestNumber: number };
}) {
  return {
    implementation: input.implementation && {
      outcome: input.implementation.outcome,
      summary: input.implementation.summary,
    },
    head: input.head,
    delivery: input.delivery,
  };
}

/** both native entry paths supply the same composer inputs, without transferring authority. */
export default function feedbackComposition<Source, Outcome>(input: {
  selection: Static<typeof assessmentSelectionSchema>;
  source: Source;
  privateResponse: string;
  verifiedOutcome: Outcome;
  suppliedOutcome?: string;
}) {
  return {
    status: 'composition-ready' as const,
    compositionContext: 'feedback/v1' as const,
    ...input,
    maximumPublicCharacters: maximumGitHubNotificationReplyLength,
  };
}
