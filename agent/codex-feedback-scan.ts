import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import feedbackOwnPublications from './feedback-own-publications.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import DiscoveryBudget, { DiscoveryPaused } from './discovery-budget.ts';
import { automationHash } from './automation-hash.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import type connectCodexFeedback from './codex-feedback-client.ts';
import { discoverCodexFeedback } from './codex-feedback-source.ts';
import type { CodexFeedback } from './codex-feedback-state.ts';
import codexHostAccess from './codex-host-access.ts';
import { revalidateFeedbackAssignment } from './assignment-feedback-reactivation.ts';
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
  budget?: DiscoveryBudget;
  checkpoint?(scan: FeedbackScan): Promise<void>;
}): Promise<FeedbackScan[]> {
  const { current, provider, now } = input;
  const budget = input.budget ?? new DiscoveryBudget();
  const policy = current.manifest.github?.notifications;
  if (!policy || !current.policy) throw new Error('feedback-intake-missing');
  await new GitHubIdentityCache(current.store.location).resolve(
    policy,
    provider.client,
    'feedback',
  );
  const intake = await current.store.read();
  if (!intake) throw new Error('feedback-intake-missing');
  const records = input.state.records
    .filter(
      (record) =>
        !record.retired &&
        !record.retirement &&
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
    if (budget.exhausted) break;
    const admitted = intake.records.find((item) => item.id === record.intakeId);
    if (!admitted) throw new Error('feedback-admission-missing');
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    let before = automationHash(record);
    const save = async () => {
      if (!input.checkpoint) return;
      await input.checkpoint({ id: record.id, before, feedback });
      record.feedback = structuredClone(feedback);
      before = automationHash(record);
    };
    feedback.scannedTime = now;
    feedback.discoveryPending = true;
    try {
      await save();
      await revalidateFeedbackAssignment(current.policy, admitted, provider.client, record);
      let publications: Promise<string[]> | undefined;
      const source = {
        state: feedback,
        ownCommentIds: () =>
          (publications ??= feedbackOwnPublications({
            record,
            intake: admitted,
            client: provider.comments,
            announcement: record.delivery?.announcement,
          })),
        client: provider.comments,
        policy,
        now,
        ...(input.checkpoint ? { discovery: { budget, save } } : {}),
        owner: admitted.repository.owner.login,
        name: admitted.repository.name,
      };
      const pr = record.delivery?.pullRequest;
      const sources = [
        {
          number: admitted.issue.number,
          nodeId: admitted.issue.nodeId,
          itemType: 'issue' as const,
        },
        ...(pr
          ? [
              {
                number: pr.pullRequestNumber,
                nodeId: pr.pullRequestNodeId,
                itemType: 'pull-request' as const,
              },
            ]
          : []),
      ].sort(
        (a, b) =>
          Number(a.nodeId === feedback.lastSource) - Number(b.nodeId === feedback.lastSource),
      );
      for (const target of sources) {
        budget.check();
        feedback.lastSource = target.nodeId;
        await save();
        if (target.itemType === 'pull-request') {
          const item = await provider.client.getItem(source.owner, source.name, target.number);
          if (item.nodeId !== target.nodeId || item.itemType !== 'pull-request')
            throw new Error('feedback-source-owner-changed');
          if (item.state !== 'open') continue;
        }
        await discoverCodexFeedback({ ...source, ...target });
      }
      feedback.scannedAt = input.occurrence;
      feedback.scannedTime = now;
      delete feedback.code;
    } catch (error) {
      if (error instanceof Error && error.message === 'discovery-checkpoint-changed') continue;
      if (error instanceof DiscoveryPaused || budget.exhausted) {
        feedback.scannedAt = input.occurrence;
        await save();
        scans.push({ id: record.id, before, feedback });
        continue;
      }
      if (error instanceof Error && /discovery-checkpoint|private-state-file/.test(error.message))
        throw error;
      if (
        (error instanceof GitHubAccountClientError ||
          error instanceof GitHubWorkEventClientError) &&
        error.providerDiagnostic?.classification === 'rate-limit'
      ) {
        feedback.code = 'feedback-github-rate-limit';
        await save();
        scans.push({ id: record.id, before, feedback });
        break;
      }
      if (codexHostAccess(error)) throw error;
      const diagnostic = error instanceof Error ? error.message : '';
      feedback.code = /^[a-z][a-z0-9-]{0,127}$/u.test(diagnostic)
        ? diagnostic
        : 'feedback-provider-unavailable';
    }
    feedback.discoveryPending = false;
    await save();
    scans.push({ id: record.id, before, feedback });
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
    if (
      !record ||
      record.retired ||
      record.retirement ||
      record.reset ||
      automationHash(record) !== scan.before
    )
      continue;
    record.feedback = scan.feedback;
    changed = true;
  }
  return changed;
}
