import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

export class GitHubNotificationPrivateResponseError extends Error {
  override name = 'GitHubNotificationPrivateResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification turn did not produce one complete private response.');
  }
}

/** Keep only user-facing final payloads, excluding OpenClaw supplemental lanes and notices. */
export function githubNotificationOrdinaryFinalPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return payloads.filter(
    ({ isCommentary, isCompactionNotice, isFallbackNotice, isReasoning, isStatusNotice }) =>
      isCommentary !== true &&
      isCompactionNotice !== true &&
      isFallbackNotice !== true &&
      isReasoning !== true &&
      isStatusNotice !== true,
  );
}

/** Summarize final payload shape without retaining model-authored content. */
export function githubNotificationPrivateResponseDiagnostics(
  payloads: readonly ReplyPayload[],
): string {
  const maximumPayloads = 8;
  const summaries = payloads
    .slice(0, maximumPayloads)
    .map((payload, index) =>
      [
        index,
        payload.text?.trim().length ?? 0,
        Number(payload.isError === true),
        Number(payload.isReasoning === true),
        Number(payload.isCommentary === true),
        Number(payload.isCompactionNotice === true),
        Number(payload.isFallbackNotice === true),
        Number(payload.isStatusNotice === true),
        Number(Boolean(payload.mediaUrl || payload.mediaUrls?.length)),
        Number(Boolean(payload.presentation)),
        Number(Boolean(payload.interactive)),
        Number(Boolean(payload.channelData)),
      ].join(':'),
    );
  return [
    `payload-count=${payloads.length}`,
    `payload-shapes=${summaries.join(',') || 'none'}`,
    `payload-shapes-truncated=${payloads.length > maximumPayloads}`,
  ].join(' ');
}

/** Select one non-empty ordinary final without imposing a publication protocol on it. */
export function githubNotificationPrivateResponse(payloads: readonly ReplyPayload[]): string {
  const ordinary = githubNotificationOrdinaryFinalPayloads(payloads);
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
