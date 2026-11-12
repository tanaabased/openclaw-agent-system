import isFilesystemAccessError from '../../../utils/is-filesystem-access-error.ts';
import { retainAnnouncementFailure } from './delivery-announcement-recovery.ts';
import { recoverRetainedAnnouncement } from './delivery-announcement.ts';
import type OpenClawDispatchContext from '../dispatch/openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord } from '../dispatch/openclaw-dispatch-state.ts';
import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import type { DispatchCaller } from '../../openclaw-session-create.ts';

/** Recheck an uncertain announcement independently of completed execution turns. */
export default async function recoverOpenClawAnnouncement(
  context: OpenClawDispatchContext,
  manifest: AgentManifest,
  workspace: string,
  record: OpenClawDispatchRecord,
  save: () => Promise<void>,
  authority: DispatchAuthority & { caller?: DispatchCaller },
) {
  const delivery = record;
  if (!delivery) return;
  const recovery = delivery.announcementRecovery;
  if (!recovery) return;
  try {
    const { intake } = await context.validate(manifest, workspace, record, false, 'native');
    await recoverRetainedAnnouncement({
      delivery,
      intake,
      now: (context.dependencies.now ?? Date.now)(),
      signal: authority.signal,
      save,
      authorize: async () => {
        await authority.assertCurrent?.();
        authority.signal?.throwIfAborted();
        await context.validate(manifest, workspace, record, false, 'native');
      },
      connect: async () => {
        if (!authority.caller || !context.dependencies.delivery)
          throw new Error('delivery-runtime-unavailable');
        return context.dependencies.delivery({
          manifest,
          workspaceDir: workspace,
          worktree: record.worktree!,
          caller: authority.caller,
          signal: authority.signal ?? new AbortController().signal,
        });
      },
    });
  } catch (error) {
    authority.signal?.throwIfAborted();
    if (isFilesystemAccessError(error)) throw error;
    retainAnnouncementFailure(
      delivery,
      recovery.binding,
      error,
      (context.dependencies.now ?? Date.now)(),
      recovery.phase,
    );
    await save();
  }
}
