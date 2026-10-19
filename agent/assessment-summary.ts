import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';
import { randomUUID } from 'node:crypto';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { AssessmentSummaryRequest, AssessmentSummary } from './assessment-summary-state.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationConnection,
} from '../channels/github/publication/comment-publisher.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication-contract.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

/** A retained assessment is its own publication source, never synthetic incoming feedback. */
export default async function assessmentSummary(input: {
  record: SharedDispatchRecord;
  intake: IntakeRecord;
  action: AssessmentSummaryRequest;
  turnId: string;
  authorityDigest: string;
  presentation: string;
  authorize(): Promise<void>;
  select(previous?: AssessmentSelection): Promise<AssessmentSelection>;
  connect(): Promise<GitHubNotificationCommentPublicationConnection>;
  redact(text: string): string;
  save(): Promise<void>;
}) {
  const { record, intake, action } = input;
  const destination = `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
  const publishedPresentation = (summary: AssessmentSummary) =>
    input.presentation +
    `\n\n[Proposed plan on GitHub ↗](${destination}#issuecomment-${summary.receipt!.databaseId})\n\n` +
    summary
      .publicText!.split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  let summary: AssessmentSummary | undefined;
  try {
    await input.authorize();
    const binding = record.stageReceipt?.binding;
    if (
      !record.result?.fullAssessment ||
      !binding ||
      !record.resultTurnId ||
      !record.assessmentRevision ||
      record.stageReceipt?.resultDigest !== automationHash(record.result) ||
      binding.workflow !== 'issue-assignment' ||
      binding.admissionId !== intake.id ||
      binding.repositoryId !== intake.repository.nodeId ||
      binding.subjectId !== intake.issue.nodeId ||
      record.reset ||
      record.retired ||
      record.handoff
    )
      throw new Error('assessment-summary-source-unavailable');
    const summaries = (record.assessmentSummaries ??= []);
    // Uncertain older writes must be reconciled before a revised summary can be composed.
    summary =
      summaries.find((entry) => entry.attempt && !entry.receipt) ??
      summaries.find((entry) => entry.revision === record.assessmentRevision);
    if (
      summary &&
      (summary.binding.workflow !== 'issue-assignment' ||
        summary.binding.admissionId !== intake.id ||
        summary.binding.repositoryId !== intake.repository.nodeId ||
        summary.binding.subjectId !== intake.issue.nodeId ||
        summary.binding.threadId !== record.threadId ||
        summary.binding.worktree !== record.worktree ||
        (summary.revision === record.assessmentRevision &&
          summary.resultDigest !== automationHash(record.result)))
    )
      throw new Error('assessment-summary-binding-mismatch');
    if (summary?.receipt)
      return {
        status: 'published',
        receipt: summary.receipt,
        destination,
        presentation: publishedPresentation(summary),
      };
    if (summary?.attempt && action.operation !== 'reconcile')
      return {
        status: 'reconcile-required',
        code: 'assessment-summary-publication-unconfirmed',
        instruction: 'Call summary operation reconcile. Never repeat an uncertain write.',
      };
    if (action.operation === 'reconcile' && !summary?.attempt)
      throw new Error('assessment-summary-publication-unattempted');
    if (action.operation !== 'reconcile') {
      if (record.resultTurnId !== input.turnId)
        throw new Error('assessment-summary-assessment-turn-required');
      if (summary && summary.turnId !== input.turnId)
        throw new Error('assessment-summary-assessment-turn-required');
      const selection = await input.select(summary?.selection);
      if (summary && automationHash(selection) !== automationHash(summary.selection)) {
        if (action.operation !== 'compose')
          throw new Error('assessment-summary-composition-changed');
        summary.selection = selection;
        delete summary.publicText;
        delete summary.code;
        await input.save();
      }
      if (!summary) {
        if (action.operation !== 'compose')
          throw new Error('assessment-summary-composition-required');
        // Supersede candidates that have never been attempted; retain every provider receipt.
        record.assessmentSummaries = summaries.filter((entry) => entry.attempt);
        if (record.assessmentSummaries.length >= 32)
          throw new Error('assessment-summary-history-full');
        summary = {
          revision: record.assessmentRevision,
          resultDigest: automationHash(record.result),
          binding,
          turnId: input.turnId,
          authorityDigest: input.authorityDigest,
          selection,
        };
        record.assessmentSummaries.push(summary);
        await input.save();
      }
      const digest = automationHash({
        ...summary,
        code: undefined,
        attempt: undefined,
        receipt: undefined,
      });
      if (action.operation === 'compose')
        return {
          status: 'composition-ready',
          digest,
          selection,
          source: { kind: 'assessment', destination, revision: summary.revision },
          privateResponse: record.result.fullAssessment,
          verifiedOutcome: { assessment: record.result },
          maximumPublicCharacters: maximumGitHubNotificationReplyLength,
          instruction:
            'The complete private assessment must already be presented here. Read and invoke the selected reply skill and applicable user/agent voice skills. Explain what the user experiences today, the proposed change, and what it will let them do, for someone unfamiliar with the code. Preserve material questions and limitations. This is a proposal, never completed implementation. Do not copy the checklist, private context or operational details; do not invent a commenter. Submit only the separate publicText through summary operation candidate with this digest. Missing skills stop composition. Changed skill content or guidance requires compose again and a new candidate before any write; never substitute a fallback.',
        };
      if (action.operation === 'candidate') {
        if (action.digest !== digest) throw new Error('assessment-summary-composition-stale');
        const text = githubNotificationPublicationText(
          'assessment-summary',
          [{ text: action.publicText ?? '' }],
          input.redact,
        );
        if (
          [
            record.result.fullAssessment.trim(),
            'plan' in record.result ? record.result.plan.trim() : undefined,
          ].includes(text)
        )
          throw new Error('assessment-summary-private-plan-rejected');
        if (summary.publicText && summary.publicText !== text)
          throw new Error('assessment-summary-candidate-conflict');
        summary.publicText = text;
        await input.save();
        return {
          status: 'candidate-recorded',
          instruction:
            'Call summary operation publish without a digest to inspect the exact destination and draft, then with its digest through native approval. This bounded summary is covered by the freshly activated assessment workflow; a native denial stops publication. Preserve the full private assessment in the final answer.',
        };
      }
      if (!summary.publicText) throw new Error('assessment-summary-candidate-required');
      if (!action.digest)
        return {
          status: 'publication-ready',
          digest,
          destination,
          body: summary.publicText,
          instruction:
            'Inspect this exact issue and proposed summary, then call summary operation publish with this digest through native approval. No new per-summary human confirmation is needed. Stop on denial; never substitute another route.',
        };
      if (action.digest !== digest) throw new Error('assessment-summary-publication-stale');
    }
    if (!summary?.publicText) throw new Error('assessment-summary-candidate-required');
    const publication = assessmentSummaryPublication(record, intake, summary);
    const publisher = new GitHubNotificationCommentPublisher({
      redactText: input.redact,
      authorize: async () => {
        await input.authorize();
        return { authorized: true };
      },
      connect: input.connect,
      exclusive: async (_key, run) => run(),
    });
    let receipt;
    if (summary.attempt) receipt = (await publisher.reconcile(publication))?.receipt;
    else {
      // A unique claim makes concurrent snapshot saves conflict before either can write twice.
      const attempt = randomUUID();
      summary.attempt = attempt;
      await input.save();
      // Saving refreshes the snapshot and replaces the unkeyed summary array.
      summary = record.assessmentSummaries?.find((entry) => entry.attempt === attempt);
      if (!summary) throw new Error('assessment-summary-state-changed');
      receipt = (await publisher.publish(publication)).receipt;
    }
    if (!receipt) throw new Error('assessment-summary-publication-unconfirmed');
    summary.receipt = { nodeId: receipt.nodeId, databaseId: receipt.databaseId };
    delete summary.code;
    await input.save();
    return {
      status: 'published',
      receipt: summary.receipt,
      destination,
      presentation: publishedPresentation(summary),
      instruction:
        'Reproduce this complete presentation in the final answer: preserve the private assessment, separate public summary and verified publication link. Publication does not mean implementation is complete.',
    };
  } catch (error) {
    if (isFilesystemAccessError(error)) throw error;
    const message = error instanceof Error ? error.message : '';
    const code = /^[a-z][a-z0-9-]{0,127}$/u.test(message)
      ? message
      : 'assessment-summary-publication-failed';
    if (summary) {
      summary.code = code;
      await input.save();
    }
    return {
      status: 'blocked',
      code,
      presentation: input.presentation,
      instruction:
        'The private assessment remains recorded. Show its complete presentation and this summary-delivery diagnostic. For an uncertain write, use summary operation reconcile; for missing authority or skill, restore the configured workflow before retrying. Stop on native denial and do not use a different publication route.',
    };
  }
}

/** Stable provider identity also lets feedback discovery recognize a lost publication receipt. */
export function assessmentSummaryPublication(
  record: Pick<SharedDispatchRecord, 'id'>,
  intake: IntakeRecord,
  summary: AssessmentSummary,
) {
  return {
    intent: 'assessment-summary' as const,
    publicationId: automationHash({
      id: record.id,
      revision: summary.revision,
      binding: summary.binding,
      result: summary.resultDigest,
    }),
    item: {
      lifecycleId: 'issue' as const,
      number: intake.issue.number,
      repositoryOwner: intake.repository.owner.login,
      repositoryName: intake.repository.name,
      repositoryNodeId: intake.repository.nodeId,
    },
    text: summary.publicText ?? '',
  };
}

/** Reconcile only; never create a comment or block unrelated feedback on an absent receipt. */
export async function assessmentSummaryOwnPublications(
  record: SharedDispatchRecord,
  intake: IntakeRecord,
  connection: GitHubNotificationCommentPublicationConnection,
  redact: (text: string) => string,
) {
  const ids: string[] = [];
  const publisher = new GitHubNotificationCommentPublisher({
    redactText: redact,
    authorize: () => ({ authorized: true }),
    connect: () => connection,
    exclusive: async (_key, run) => run(),
  });
  for (const summary of record.assessmentSummaries ?? []) {
    if (summary.receipt) ids.push(summary.receipt.nodeId);
    else if (summary.attempt && summary.publicText) {
      const found = await publisher.reconcile(
        assessmentSummaryPublication(record, intake, summary),
      );
      if (found) ids.push(found.receipt.nodeId);
    }
  }
  return ids;
}
