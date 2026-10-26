import { automationHash } from './automation-hash.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ImplementationResult } from './implementation-result.ts';

/** Retain the result only after the runtime verifies completed work's checkout. */
export async function recordFeedbackImplementation(
  event: Pick<FeedbackSourceEvent, 'work'>,
  result: ImplementationResult | undefined,
  readHead: () => Promise<string>,
) {
  const work = event.work;
  if (!work || !result) throw new Error('feedback-implementation-context-required');
  if (work.result && automationHash(work.result) !== automationHash(result))
    throw new Error('feedback-implementation-result-conflict');
  if (result.outcome === 'done') {
    const head = await readHead();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-head-invalid');
    if (work.head && work.head !== head) throw new Error('feedback-implementation-head-changed');
    work.head = head;
  }
  work.result = result;
}

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
