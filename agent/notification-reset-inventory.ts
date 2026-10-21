import type { IntakeState } from '../channels/github/intake/record-store.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { NotificationResetResource } from './notification-reset-state.ts';

export type ResetDispatchRecord = DispatchRecord | OpenClawDispatchRecord;
export interface ResetInventory {
  intake: IntakeState;
  records: ResetDispatchRecord[];
}

/** retain ownership before clearing routing; path names alone never establish custody. */
export function notificationResetResources(inventory: ResetInventory): NotificationResetResource[] {
  const result = new Map<string, NotificationResetResource>();
  const add = (
    kind: NotificationResetResource['kind'],
    id: string,
    description: string,
    record: ResetDispatchRecord,
    details: string[],
  ) => {
    const key = `${kind}:${id}`;
    if (!result.has(key))
      result.set(key, {
        id: key,
        kind,
        description,
        identity: record.id,
        details,
        state: 'pending',
      });
  };
  for (const record of inventory.records) {
    if (record.threadId)
      add('chat', record.threadId, record.threadId, record, ['archive the managed conversation']);
    const delivery =
      'work' in record ? record.work?.delivery : 'delivery' in record ? record.delivery : undefined;
    const pr = delivery?.pullRequest;
    if (delivery?.creationAttempted && !pr)
      throw new Error('notification-reset-pr-creation-unresolved');
    if (pr) {
      const intake = inventory.intake.records.find(({ id }) => id === record.intakeId);
      if (!intake) throw new Error('notification-reset-intake-identity-missing');
      const repository = `${intake.repository.owner.login}/${intake.repository.name}`;
      add('pull-request', pr.pullRequestNodeId, `${repository}#${pr.pullRequestNumber}`, record, [
        'close only if still open and unmerged',
        'keep named and remote branches',
      ]);
    }
    if (record.worktree)
      add('worktree', record.worktree, record.worktree, record, [
        'remove the managed checkout including modified, untracked, and ignored files',
        'keep the repository and named branches',
      ]);
  }
  // archive before deleting the checkout; a closure failure retains the recovery inventory.
  return [...result.values()].sort(
    (a, b) =>
      ['chat', 'pull-request', 'worktree'].indexOf(a.kind) -
        ['chat', 'pull-request', 'worktree'].indexOf(b.kind) || a.id.localeCompare(b.id),
  );
}
