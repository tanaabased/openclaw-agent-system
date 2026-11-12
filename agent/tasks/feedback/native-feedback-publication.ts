import type { SharedDispatchRecord } from '../dispatch/dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { dispatchAdmission, type ManagedIssue } from '../managed-issue.ts';
import { assertNativeContextInput } from '../context/native-context-request.ts';
import { feedbackTarget, replyLocator } from './reply-target.ts';
/** Explicit operator recovery selects an exact source and retained text, never a latest draft. */
export default function nativeFeedbackPublication(
  input: Record<string, unknown>,
  records: readonly (SharedDispatchRecord & {
    feedback?: {
      events: readonly (FeedbackSourceEvent & {
        result?: {
          publicText?: string;
        };
      })[];
    };
  })[],
  admitted: readonly ManagedIssue[],
) {
  assertNativeContextInput(input);
  if (
    Object.keys(input).some(
      (key) => !['action', 'source', 'publicText', 'preview'].includes(key),
    ) ||
    input.action !== 'publish-approved' ||
    typeof input.source !== 'string' ||
    !replyLocator(input.source).commentId ||
    (input.preview !== undefined && typeof input.preview !== 'boolean') ||
    (input.publicText !== undefined && typeof input.publicText !== 'string') ||
    (!input.preview && !input.publicText)
  )
    throw new Error('feedback-publication-request-invalid');
  const matches = records.flatMap((record) => {
    if (record.reset || record.supersededBy) return [];
    const issue = dispatchAdmission(record, admitted);
    if (!issue) return [];
    const repository = `${issue.repository.owner.login}/${issue.repository.name}`;
    return (record.feedback?.events ?? [])
      .filter(
        (event) =>
          feedbackTarget(repository, event) === input.source &&
          (input.publicText === undefined || event.result?.publicText === input.publicText),
      )
      .map((event) => ({ id: record.id, eventId: event.id }));
  });
  if (matches.length !== 1)
    throw new Error(matches.length ? 'feedback-source-ambiguous' : 'feedback-source-not-admitted');
  return {
    action: 'publish-approved',
    ...matches[0]!,
    apply: !input.preview,
    ...(input.publicText === undefined ? {} : { publicText: input.publicText }),
  };
}
