import { automationHash } from './automation-hash.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import type connectCodexFeedback from './codex-feedback-client.ts';
import { discoverCodexFeedback } from './codex-feedback-source.ts';
import type { CodexFeedback } from './codex-feedback-state.ts';
import codexHostAccess from './codex-host-access.ts';
import revalidateAssignment from './dispatch-assignment.ts';
import type { selectCodexIntake } from './codex-intake.ts';

export interface FeedbackScan {
  id: string;
  before: string;
  feedback: CodexFeedback;
}

/** provider discovery runs without the journal lock; changed owners discard stale snapshots. */
export async function scanCodexFeedback(input: {
  state: DispatchState;
  current: Awaited<ReturnType<typeof selectCodexIntake>>;
  provider: Awaited<ReturnType<typeof connectCodexFeedback>>;
  occurrence: string;
  sourceThreadId: string;
  now: number;
}): Promise<FeedbackScan[]> {
  const { current, provider, now } = input;
  const policy = current.manifest.github?.notifications;
  if (policy?.schemaVersion !== 2 || !current.policy) throw new Error('feedback-intake-missing');
  const intake = await current.store.read();
  if (!intake) throw new Error('feedback-intake-missing');
  const records = input.state.records
    .filter(
      (record) =>
        !record.retired &&
        !record.reset &&
        record.effective &&
        record.threadId &&
        record.request &&
        record.worktree &&
        record.project &&
        record.feedback?.scannedAt !== input.occurrence,
    )
    .sort((a, b) => (a.feedback?.scannedTime ?? 0) - (b.feedback?.scannedTime ?? 0))
    .slice(0, 12);
  const scans: FeedbackScan[] = [];
  for (const record of records) {
    const admitted = intake.records.find((item) => item.id === record.intakeId);
    if (!admitted) throw new Error('feedback-admission-missing');
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    try {
      if (record.sourceThreadId !== input.sourceThreadId)
        throw new Error('feedback-schedule-owner-changed');
      await revalidateAssignment(current.policy, admitted, provider.client);
      const source = {
        state: feedback,
        client: provider.comments,
        policy,
        now,
        owner: admitted.repository.owner.login,
        name: admitted.repository.name,
      };
      await discoverCodexFeedback({
        ...source,
        number: admitted.issue.number,
        nodeId: admitted.issue.nodeId,
        itemType: 'issue',
      });
      const pr = record.delivery?.pullRequest;
      if (pr) {
        const item = await provider.client.getItem(source.owner, source.name, pr.pullRequestNumber);
        if (
          item.nodeId !== pr.pullRequestNodeId ||
          item.itemType !== 'pull-request' ||
          item.state !== 'open'
        )
          throw new Error('feedback-delivery-pr-unavailable');
        await discoverCodexFeedback({
          ...source,
          number: pr.pullRequestNumber,
          nodeId: pr.pullRequestNodeId,
          itemType: 'pull-request',
        });
      }
      feedback.scannedAt = input.occurrence;
      feedback.scannedTime = now;
      delete feedback.code;
    } catch (error) {
      if (codexHostAccess(error)) throw error;
      const diagnostic = error instanceof Error ? error.message : '';
      feedback.code = /^[a-z][a-z0-9-]{0,127}$/u.test(diagnostic)
        ? diagnostic
        : 'feedback-provider-unavailable';
    }
    scans.push({ id: record.id, before: automationHash(record), feedback });
  }
  return scans;
}

/** called under the journal lock; never replace concurrently saved results or receipts. */
export function applyFeedbackScans(
  records: DispatchRecord[],
  scans: readonly FeedbackScan[],
): boolean {
  let changed = false;
  for (const scan of scans) {
    const record = records.find((entry) => entry.id === scan.id);
    if (!record || record.retired || record.reset || automationHash(record) !== scan.before)
      continue;
    record.feedback = scan.feedback;
    changed = true;
  }
  return changed;
}
