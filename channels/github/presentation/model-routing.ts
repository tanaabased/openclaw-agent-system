import type { RoutingDecision } from '../../../agent/model-routing.ts';
import githubNotificationCard, {
  githubNotificationMarkdownCode as code,
  githubNotificationMarkdownText as text,
} from './card.ts';

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
      { label: 'Selected', value: code(routing.model) + ' / ' + code(routing.effort) },
      { label: 'Basis', value: code(routing.complexity) + ' complexity. ' + text(routing.reason) },
      {
        label: 'Source',
        value:
          (routing.profile ? code(routing.profile) + ' profile' : 'Explicit selection') +
          '; ' +
          text(routing.source),
      },
      {
        label: 'Effective settings',
        value:
          effective?.status === 'verified' && effective.model && effective.effort
            ? 'Verified: ' + code(effective.model) + ' / ' + code(effective.effort)
            : 'Not independently verified.',
      },
      {
        label: 'Execution',
        value: executionModel
          ? code(executionModel) + '; effort unverified.'
          : 'Model and effort not independently verified.',
      },
    ],
  });
}
