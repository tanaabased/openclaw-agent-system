import type { Static } from 'typebox';

import type { assessmentSelectionSchema } from './assessment-selection.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

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
