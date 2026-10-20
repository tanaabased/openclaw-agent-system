import type { RoutingDecision } from '../../../agent/model-routing.ts';
import githubNotificationCard, { githubNotificationMarkdownText as text } from './card.ts';

export interface RoutingPresentation {
  routing: Pick<RoutingDecision, 'complexity' | 'profile' | 'reason' | 'source'> & {
    model: string;
    effort: string;
  };
  effective?: { status: 'verified' | 'unverified'; model?: string; effort?: string };
  executionModel?: string;
}

export default function modelRoutingCard({
  routing,
  effective,
  executionModel,
}: RoutingPresentation) {
  return githubNotificationCard({
    emoji: '🧠',
    title: 'Model routing',
    facts: [
      { label: 'Selected', value: text(routing.model + ' / ' + routing.effort) },
      { label: 'Basis', value: text(routing.complexity + ' complexity. ' + routing.reason) },
      {
        label: 'Source',
        value: text(
          (routing.profile ? routing.profile + ' profile' : 'Explicit selection') +
            '; ' +
            routing.source,
        ),
      },
      {
        label: 'Effective settings',
        value:
          effective?.status === 'verified' && effective.model && effective.effort
            ? 'Verified: ' + text(effective.model + ' / ' + effective.effort)
            : 'Not independently verified.',
      },
      {
        label: 'Execution',
        value: executionModel
          ? text(executionModel) + '; effort unverified.'
          : 'Model and effort not independently verified.',
      },
    ],
  });
}
