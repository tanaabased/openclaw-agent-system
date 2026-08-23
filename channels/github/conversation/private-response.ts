import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

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

/** Enforce stable report sections for one assignment response. */
export function githubNotificationPlanningPrivateResponse(value: string): string {
  const text = value.trim();
  const assessmentIndex = text.indexOf('## Assessment');
  const headings = text.match(/^## .+$/gmu) ?? [];
  const secondHeading = headings[1];
  if (
    assessmentIndex !== 0 ||
    headings.length !== 2 ||
    headings[0] !== '## Assessment' ||
    (secondHeading !== '## Plan' && secondHeading !== '## Questions') ||
    text.indexOf(secondHeading) <= assessmentIndex + '## Assessment'.length
  ) {
    throw new GitHubNotificationPrivateResponseError(
      'github-notification-planning-private-response-invalid',
    );
  }
  return text;
}
