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
    instructions:
      'privateResponse contains the human-facing answer, not instructions to the reply composer. Present any additional private information as ordinary chat prose without a generic Response heading. Keep workflow steps, tool arguments and rendering directions outside that answer. Apply the selected skill and guidance privately to produce the public candidate.',
    ...input,
    maximumPublicCharacters: maximumGitHubNotificationReplyLength,
  };
}
