import { feedbackTarget, replyLocator } from './reply-target.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';

/** select a real comment choice within an already-bound owner; never choose the latest event. */
export default function nativeFeedbackSource<T extends FeedbackSourceEvent>(
  events: readonly T[],
  currentId: string | undefined,
  repository: string | undefined,
  source: unknown,
) {
  const current = events.find((event) => event.id === currentId);
  if (source === undefined) {
    if (!current) throw new Error('feedback-source-selection-required');
    return current;
  }
  if (typeof source !== 'string' || !replyLocator(source).commentId)
    throw new Error('feedback-source-url-required');
  if (!repository) throw new Error('feedback-source-owner-unavailable');
  const matches = events.filter((event) => feedbackTarget(repository, event) === source);
  if (current && matches.includes(current)) return current;
  if (matches.length !== 1)
    throw new Error(matches.length ? 'feedback-source-ambiguous' : 'feedback-source-not-admitted');
  return matches[0]!;
}
