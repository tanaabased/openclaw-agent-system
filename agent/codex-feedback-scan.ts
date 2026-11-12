import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import { revalidateFeedbackAssignment } from './assignment-feedback-reactivation.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import type connectCodexFeedback from './codex-feedback-client.ts';
import { discoverFeedback } from './feedback-source.ts';
import type { CodexFeedback } from './codex-feedback-state.ts';
import codexHostAccess from './codex-host-access.ts';
import type { CodexTaskSelection } from './tasks/context/codex-task-context.ts';
import DiscoveryBudget, { DiscoveryPaused } from './discovery-budget.ts';
import feedbackDiscoveryOwner from './feedback-discovery-owner.ts';
import feedbackOwnPublications from './feedback-own-publications.ts';
import feedbackSources from './feedback-sources.ts';
import { dispatchAdmission } from './managed-issue.ts';
import replyOwnPublications from './reply-own-publications.ts';
import workflowFailure from './workflow-failure.ts';
export interface FeedbackScan {
  id: string;
  before: string;
  feedback: CodexFeedback;
}
/** provider discovery runs without the journal lock; changed owners discard stale snapshots. */
export async function scanCodexFeedback(input: {
  state: DispatchState;
  current: CodexTaskSelection;
  provider: Awaited<ReturnType<typeof connectCodexFeedback>>;
  occurrence: string;
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
    true,
  );
  const intake = await current.store.read();
  if (!intake) throw new Error('feedback-intake-missing');
  const records = input.state.records
    .filter(
      (record) =>
        !record.retirement &&
        !record.reset &&
        record.threadId &&
        record.request &&
        record.worktree &&
        record.feedback?.scannedAt !== input.occurrence,
    )
    .sort((a, b) => (a.feedback?.scannedTime ?? 0) - (b.feedback?.scannedTime ?? 0))
    .slice(0, 12);
  const scans: FeedbackScan[] = [];
  for (const record of records) {
    if (budget.exhausted) break;
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    let before = feedbackDiscoveryOwner(record);
    const save = async () => {
      if (!input.checkpoint) return;
      await input.checkpoint({ id: record.id, before, feedback });
      record.feedback = structuredClone(feedback);
      before = feedbackDiscoveryOwner(record);
    };
    feedback.scannedTime = now;
    feedback.discoveryPending = true;
    try {
      const admitted = dispatchAdmission(record, intake.records ?? []);
      if (!admitted) throw new Error('feedback-admission-missing');
      await save();
      await revalidateFeedbackAssignment(current.policy, admitted, provider.client, record);
      let publications: Promise<string[]> | undefined;
      const source = {
        state: feedback,
        ownCommentIds: () =>
          (publications ??= feedbackOwnPublications({
            intake: admitted,
            client: provider.comments,
            announcement: record.announcement,
            replies: () =>
              replyOwnPublications({
                root: current.store.location.root,
                binding: {
                  runtime: 'codex',
                  agentId: current.agentId,
                  workspace: current.workspace,
                  namespace: current.codexHome,
                  session: record.threadId!,
                  incarnation: record.threadId!,
                },
                client: provider.comments,
                replies: provider.replies,
              }),
          })),
        client: provider.comments,
        policy,
        now,
        ...(input.checkpoint ? { discovery: { budget, save } } : {}),
        owner: admitted.repository.owner.login,
        name: admitted.repository.name,
      };
      const sources = feedbackSources(record, admitted, feedback);
      for (const target of sources) {
        budget.check();
        feedback.lastSource = target.nodeId;
        await save();
        if (target.itemType === 'pull-request') {
          const item = await provider.client.getItem(source.owner, source.name, target.number);
          if (item.nodeId !== target.nodeId || item.itemType !== 'pull-request')
            throw new Error('feedback-source-owner-changed');
          if (item.state !== 'open') {
            delete feedback.discovery?.[target.nodeId];
            await save();
            continue;
          }
        }
        await discoverFeedback({ ...source, ...target });
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
      feedback.code = workflowFailure(error, 'feedback-provider-unavailable').code;
    }
    feedback.discoveryPending = false;
    await save();
    scans.push({ id: record.id, before, feedback });
  }
  return scans;
}
export { default as applyFeedbackScans } from './apply-feedback-scans.ts';
