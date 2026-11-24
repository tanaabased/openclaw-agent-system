import type { SessionStorage } from '../../storage/storage-lifecycle.ts';
import { DirectEntryStore } from '../direct-entry-store.ts';
import { implementationEntriesSchema } from '../implementation/implementation-entry-state.ts';
import type { TaskAdmission } from '../task-admission.ts';
import ReplyStore, { type ReplyBinding } from '../feedback/reply-store.ts';
import {
  retirementDeliveryEffects,
  retirementReplyEffect,
  type RetirementEffect,
} from './retirement-effects.ts';

/** transfer uncertain writes before deleting the exact native task's copied local material. */
export default async function retirementLocalData(input: {
  sessionStorage?: SessionStorage;
  root: string;
  binding: ReplyBinding;
  intake: TaskAdmission;
  retain(effects: RetirementEffect[]): Promise<void>;
}) {
  const owns = (entry: { repositoryId: string; subjectId: string }) =>
    entry.repositoryId === input.intake.repository.nodeId &&
    entry.subjectId === input.intake.issue.nodeId;
  await new ReplyStore(input.root, input.binding, input.sessionStorage).edit(
    async (drafts, save) => {
      await input.retain(
        drafts.flatMap((draft) => {
          const effect = retirementReplyEffect(draft);
          return effect ? [effect] : [];
        }),
      );
      drafts.splice(0);
      await save();
    },
  );
  if ('origin' in input.intake) return;
  await new DirectEntryStore(
    input.root,
    input.binding,
    implementationEntriesSchema,
    'implementation',
    input.sessionStorage,
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
