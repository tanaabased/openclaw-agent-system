import { DirectEntryStore } from './direct-entry-store.ts';
import { implementationEntriesSchema } from './implementation-entry-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import ReplyStore, { type ReplyBinding } from './reply-store.ts';
import {
  retirementDeliveryEffects,
  retirementReplyEffect,
  type RetirementEffect,
} from './retirement-effects.ts';

/** transfer uncertain writes before deleting the exact native task's copied local material. */
export default async function retirementLocalData(input: {
  root: string;
  binding: ReplyBinding;
  intake: ManagedIssue;
  retain(effects: RetirementEffect[]): Promise<void>;
}) {
  const owns = (entry: { repositoryId: string; subjectId: string }) =>
    entry.repositoryId === input.intake.repository.nodeId &&
    entry.subjectId === input.intake.issue.nodeId;
  await new ReplyStore(input.root, input.binding).exclusive(async (drafts, save) => {
    await input.retain(
      drafts.flatMap((draft) => {
        const effect = retirementReplyEffect(draft);
        return effect ? [effect] : [];
      }),
    );
    drafts.splice(0);
    await save();
  });
  await new DirectEntryStore(
    input.root,
    input.binding,
    implementationEntriesSchema,
    'implementation',
  ).exclusive(async (entries, save) => {
    await input.retain(
      entries
        .filter(owns)
        .flatMap((entry) => retirementDeliveryEffects(entry.delivery, input.intake)),
    );
    entries.splice(0, entries.length, ...entries.filter((entry) => !owns(entry)));
    await save(true);
  });
}
