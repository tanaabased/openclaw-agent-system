import type { FeedbackSourceEvent } from './feedback-state.ts';

export function recordFeedbackResponse(
  event: Pick<FeedbackSourceEvent, 'result' | 'replyRequested' | 'phase'>,
  privateText: string,
  replyRequested: boolean,
) {
  if (
    event.result &&
    (event.result.privateText !== privateText || event.replyRequested !== replyRequested)
  )
    throw new Error('feedback-result-conflict');
  event.result ??= { privateText };
  event.replyRequested = replyRequested;
  event.phase = replyRequested ? 'responded' : 'published';
}

export function recordFeedbackCandidate(
  result: NonNullable<FeedbackSourceEvent['result']>,
  publicText: string,
) {
  if (result.publicText && result.publicText !== publicText)
    throw new Error('feedback-result-conflict');
  result.publicText = publicText;
}
