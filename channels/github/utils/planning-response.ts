import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationPublicationText } from './publication.ts';

export class GitHubNotificationPlanningResponseError extends Error {
  override name = 'GitHubNotificationPlanningResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification planning response did not contain a safe acknowledgment.');
  }
}

function planningResponseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function assertPlanningSections(response: string): void {
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

function hasPlanningSections(payload: ReplyPayload): boolean {
  try {
    assertPlanningSections(planningResponseText(payload));
    return true;
  } catch {
    return false;
  }
}

/** Select one complete private planning reply, preferring an ordinary final over commentary. */
export function assertGitHubNotificationPlanningResponse(
  payloads: readonly ReplyPayload[],
): ReplyPayload {
  const textPayloads = payloads.filter((payload) => planningResponseText(payload));
  if (textPayloads.length === 0) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-missing',
    );
  }
  const completePayloads = textPayloads.filter(hasPlanningSections);
  const ordinaryPayloads = completePayloads.filter(({ isCommentary }) => isCommentary !== true);
  const candidates =
    ordinaryPayloads.length > 0
      ? ordinaryPayloads
      : completePayloads.filter(({ isCommentary }) => isCommentary === true);
  if (candidates.length !== 1 || !candidates[0]) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-invalid',
    );
  }
  return candidates[0];
}

/** Extract only the explicit public candidate from an otherwise private planning response. */
export default function githubNotificationPlanningAcknowledgment(
  payloads: readonly ReplyPayload[],
): string {
  const response = payloads.map(planningResponseText).filter(Boolean).join('\n');
  const matches = [...response.matchAll(/^ACKNOWLEDGMENT:[ \t]*(.+?)[ \t]*$/gmu)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-acknowledgment-missing',
    );
  }
  return githubNotificationPublicationText('initial-acknowledgment', [{ text: matches[0][1] }]);
}
