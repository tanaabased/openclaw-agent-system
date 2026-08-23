import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import type { GitHubNotificationPlanningOutcome } from '../publication/publication.ts';

export class GitHubNotificationPrivateResponseError extends Error {
  override name = 'GitHubNotificationPrivateResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification turn did not produce one complete private response.');
  }
}

/** Select one non-empty ordinary final without imposing a publication protocol on it. */
export function githubNotificationPrivateResponse(payloads: readonly ReplyPayload[]): string {
  const ordinary = payloads.filter(({ isCommentary }) => isCommentary !== true);
  const complete = ordinary.filter(
    (payload) => payload.isError !== true && Boolean(payload.text?.trim()),
  );
  if (complete.length !== 1 || !complete[0]) {
    throw new GitHubNotificationPrivateResponseError(
      complete.length === 0
        ? 'github-notification-private-response-missing'
        : 'github-notification-private-response-invalid',
    );
  }
  return complete[0].text!.trim();
}

/** Enforce stable report sections for one typed assignment planning outcome. */
export function githubNotificationPlanningPrivateResponse(
  value: string,
  outcome: GitHubNotificationPlanningOutcome,
): string {
  const text = value.trim();
  const expectedSecondHeading = outcome === 'plan' ? '## Plan' : '## Questions';
  const assessmentIndex = text.indexOf('## Assessment');
  const secondIndex = text.indexOf(expectedSecondHeading);
  const headings = text.match(/^## .+$/gmu) ?? [];
  if (
    assessmentIndex !== 0 ||
    secondIndex <= assessmentIndex + '## Assessment'.length ||
    headings.length !== 2 ||
    headings[0] !== '## Assessment' ||
    headings[1] !== expectedSecondHeading
  ) {
    throw new GitHubNotificationPrivateResponseError(
      'github-notification-planning-private-response-invalid',
    );
  }
  return text;
}
