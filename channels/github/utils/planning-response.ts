import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationPublicationText } from './publication.ts';

export class GitHubNotificationPlanningResponseError extends Error {
  override name = 'GitHubNotificationPlanningResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification planning response did not contain a safe acknowledgment.');
  }
}

function planningResponseText(payloads: readonly ReplyPayload[]): string {
  return payloads
    .map(({ text }) => text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

/** Require the private planning sections before treating an adopted turn as complete. */
export function assertGitHubNotificationPlanningResponse(payloads: readonly ReplyPayload[]): void {
  const response = planningResponseText(payloads);
  const sections = [...response.matchAll(/^(ASSESSMENT|BLOCKERS|PLAN):[ \t]*$/gmu)];
  if (sections.map((match) => match[1]).join(',') !== 'ASSESSMENT,BLOCKERS,PLAN') {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-invalid',
    );
  }
  for (const [index, section] of sections.entries()) {
    const start = (section.index ?? 0) + section[0].length;
    const end = sections[index + 1]?.index ?? response.length;
    if (!response.slice(start, end).trim()) {
      throw new GitHubNotificationPlanningResponseError(
        'github-notification-planning-response-invalid',
      );
    }
  }
}

/** Extract only the explicit public candidate from an otherwise private planning response. */
export default function githubNotificationPlanningAcknowledgment(
  payloads: readonly ReplyPayload[],
): string {
  const response = planningResponseText(payloads);
  const matches = [...response.matchAll(/^ACKNOWLEDGMENT:[ \t]*(.+?)[ \t]*$/gmu)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-acknowledgment-missing',
    );
  }
  return githubNotificationPublicationText('initial-acknowledgment', [{ text: matches[0][1] }]);
}
