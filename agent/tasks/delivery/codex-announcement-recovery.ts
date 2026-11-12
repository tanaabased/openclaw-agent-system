import codexHostAccess from '../../codex-host-access.ts';
import {
  announcementRecoveryAction,
  retainAnnouncementFailure,
} from './delivery-announcement-recovery.ts';
import { recoverRetainedAnnouncement } from './delivery-announcement.ts';
import { dispatchAdmission } from '../../managed-issue.ts';
import { inspectIssueIdentity } from '../../dispatch-assignment.ts';
import connectCodexGitHubAccount from '../../codex-github-client.ts';
import type { DispatchRecord } from '../../codex-dispatch-state.ts';
import type { CodexWorkContext } from '../../codex-continuation-context.ts';

/** Recover one uncertain announcement without entering implementation or sending a model turn. */
export default async function recoverCodexAnnouncement(
  record: DispatchRecord,
  context: CodexWorkContext,
) {
  const delivery = record;
  const { current, deps, signal, save } = context;
  if (!delivery || announcementRecoveryAction(delivery, (deps.now ?? Date.now)()) !== 'check')
    return;
  const recovery = delivery.announcementRecovery;
  if (!recovery) return;
  try {
    const intake = dispatchAdmission(record, context.admissions?.records ?? []);
    if (!intake) throw new Error('delivery-admission-missing');
    let connected: Awaited<ReturnType<typeof connectCodexGitHubAccount>> | undefined;
    const connect = async () =>
      (connected ??= await (deps.deliveryDependencies?.connect ?? connectCodexGitHubAccount)(
        current.workspace,
        signal,
      ));
    const authorize = async () => {
      signal.throwIfAborted();
      await inspectIssueIdentity(intake, (await connect()).client);
    };
    await recoverRetainedAnnouncement({
      delivery,
      intake,
      signal,
      save,
      now: (deps.now ?? Date.now)(),
      authorize,
      connect: async () => {
        const connection = await connect();
        await inspectIssueIdentity(intake, connection.client);
        return connection;
      },
    });
  } catch (error) {
    signal.throwIfAborted();
    if (codexHostAccess(error)) throw error;
    retainAnnouncementFailure(
      delivery,
      recovery.binding,
      error,
      (deps.now ?? Date.now)(),
      recovery.phase,
    );
    await save();
  }
}
