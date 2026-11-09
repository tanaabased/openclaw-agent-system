import type { ReplyDraft } from './reply-store.ts';
import type { ReplyTarget } from './reply-target.ts';
import type { ReplyExecutionRequest } from '../tools/dispatch/reply-schema.ts';

/** a semantic choice narrows existing native custody; ordering never selects a draft. */
export default function selectReplyDraft(
  drafts: readonly ReplyDraft[],
  input: Pick<
    ReplyExecutionRequest,
    'target' | 'privateText' | 'publicText' | 'operation' | 'purpose'
  >,
  native: { turnId: string; inputId: string; feedback?: ReplyDraft['feedback'] },
) {
  const matches = drafts.filter((draft) => {
    if (input.target && (JSON.parse(draft.target) as ReplyTarget).url !== input.target)
      return false;
    if (input.purpose && !draft.update) return false;
    if (input.privateText !== undefined && draft.privateText !== input.privateText) return false;
    if (
      input.operation !== 'candidate' &&
      input.publicText !== undefined &&
      draft.publicText !== input.publicText
    )
      return false;
    if (native.feedback)
      return (
        draft.feedback?.ownerId === native.feedback.ownerId &&
        draft.feedback.eventId === native.feedback.eventId &&
        draft.feedback.revision === native.feedback.revision
      );
    // An explicit destination can resume a retained draft. Implicit use belongs to this input.
    return (
      Boolean(input.target) || (draft.turnId === native.turnId && draft.inputId === native.inputId)
    );
  });
  const current = matches.filter(
    (draft) => draft.turnId === native.turnId && draft.inputId === native.inputId,
  );
  const selected = current.length ? current : matches;
  if (selected.length > 1)
    throw new Error(
      'reply-draft-selection-required: select the destination or the exact authored privateText/publicText',
    );
  return selected[0];
}
