import publicResponse from './public-response.ts';
import publicResponsePresentation from '../channels/github/presentation/public-response.ts';
import workflowFailure from './workflow-failure.ts';
import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';
import { randomUUID } from 'node:crypto';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { AssessmentSummaryRequest, AssessmentSummary } from './assessment-summary-state.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import type { ManagedIssue as IntakeRecord } from './managed-issue.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationConnection,
} from '../channels/github/publication/comment-publisher.ts';
import { githubCommentCard } from '../channels/github/presentation/comment.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication-contract.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

function summaryDigest(summary: AssessmentSummary) {
  return automationHash({
    ...summary,
    code: undefined,
    attempt: undefined,
    receipt: undefined,
    authorLogin: undefined,
    diagnostic: undefined,
    publicationCommand: undefined,
    nativeDenial: undefined,
    previewDigest: undefined,
  });
}

/** A retained assessment is its own publication source, never synthetic incoming feedback. */
export default async function assessmentSummary(input: {
  record: SharedDispatchRecord;
  intake: IntakeRecord;
  action: AssessmentSummaryRequest;
  turnId: string;
  recovery?: boolean;
  authorityDigest: string;
  presentation: string;
  authorize(): Promise<void>;
  select(previous?: AssessmentSelection): Promise<AssessmentSelection>;
  connect(): Promise<GitHubNotificationCommentPublicationConnection & { authorLogin?: string }>;
  redact(text: string): string;
  save(): Promise<void>;
  publicationCommand?(digest: string): string;
}) {
  const { record, intake, action } = input;
  const destination = `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
  const summaryCard = (summary: AssessmentSummary) =>
    githubCommentCard({
      body: summary.publicText!,
      author: summary.authorLogin
        ? {
            label: summary.authorLogin,
            url: `https://github.com/${encodeURIComponent(summary.authorLogin)}`,
          }
        : undefined,
      label: 'Plan assessment',
      connector: 'by',
      publication: summary.receipt
        ? { url: `${destination}#issuecomment-${summary.receipt.databaseId}` }
        : { draft: true },
    });
  let summary: AssessmentSummary | undefined;
  try {
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
      record.retired
    )
      throw new Error('assessment-summary-source-unavailable');
    const summaries = (record.assessmentSummaries ??= []);
    // Uncertain older writes must be reconciled before a revised summary can be composed.
    summary =
      summaries.find((entry) => entry.code && /denied|cancelled/.test(entry.code)) ??
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
    if (summary?.code && /denied|cancelled/.test(summary.code)) throw new Error(summary.code);
    // a reported refusal only restricts this saved effect; it never supplies native authority.
    if (action.operation === 'hold') {
      if (!summary?.publicText || summary.attempt || summary.receipt)
        throw new Error('assessment-summary-hold-source-unavailable');
      if (action.digest !== summary.previewDigest || action.digest !== summaryDigest(summary))
        throw new Error('assessment-summary-publication-stale');
      summary.code = 'assessment-summary-native-approval-denied';
      summary.diagnostic = input.redact(
        action.diagnostic ?? 'Native approval denied this assessment summary.',
      );
      await input.save();
      throw new Error(summary.code);
    }
    await input.authorize();
    if (summary?.receipt)
      return {
        status: 'published',
        receipt: summary.receipt,
        destination,
        presentation: input.presentation + '\n\n' + summaryCard(summary),
      };
    if (summary?.attempt && action.operation !== 'reconcile')
      return {
        status: 'reconcile-required',
        code: 'assessment-summary-publication-unconfirmed',
        presentation: [
          input.presentation,
          summary.publicText && summaryCard(summary),
          publicResponsePresentation({ kind: 'Assessment summary', destination, attempted: true }),
        ]
          .filter(Boolean)
          .join('\n\n'),
        instruction: 'Call summary operation reconcile. Never repeat an uncertain write.',
      };
    if (action.operation === 'reconcile' && !summary?.attempt)
      throw new Error('assessment-summary-publication-unattempted');
    if (action.operation !== 'reconcile') {
      if (record.resultTurnId !== input.turnId && !input.recovery)
        throw new Error('assessment-summary-assessment-turn-required');
      if (summary && summary.turnId !== input.turnId && !input.recovery)
        throw new Error('assessment-summary-assessment-turn-required');
      if (summary && summary.turnId !== input.turnId && input.recovery) {
        summary.turnId = input.turnId;
        summary.authorityDigest = input.authorityDigest;
        await input.save();
      }
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
        record.assessmentSummaries = summaries.filter(
          (entry) =>
            entry.attempt || entry.receipt || (entry.code && /denied|cancelled/.test(entry.code)),
        );
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
      const digest = summaryDigest(summary);
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
            'The recorded private review must already be presented here; the full assessment stays saved for implementation and on-demand inspection. Read and invoke the selected reply skill and applicable user/agent voice skills. Explain what the user experiences today, the proposed change, and what it will let them do, for someone unfamiliar with the code. Preserve material questions and limitations. This is a proposal, never completed implementation. Do not copy the checklist, private context or operational details; do not invent a commenter. Submit only the separate publicText through summary operation candidate with this digest. Missing skills stop composition. Changed skill content or guidance requires compose again and a new candidate before any write; never substitute a fallback.',
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
            'Call summary operation publish without a digest to inspect the exact destination and draft, then with its digest through native approval. This bounded summary is covered by the freshly activated assessment workflow; a native denial stops publication. Preserve the recorded private review presentation in the final answer; keep the full assessment saved for implementation.',
        };
      }
      if (!summary.publicText) throw new Error('assessment-summary-candidate-required');
      if (!action.digest) {
        summary.previewDigest = digest;
        if (input.publicationCommand) {
          summary.publicationCommand = input.publicationCommand(digest);
        }
        await input.save();
        return {
          status: 'publication-ready',
          digest,
          destination,
          body: summary.publicText,
          presentation: summaryCard(summary),
          ...(summary.publicationCommand ? { command: summary.publicationCommand } : {}),
          instruction:
            'Inspect this exact issue and proposed summary, then call summary operation publish with this digest through native approval. When command is supplied, use that exact single-command transport. No new per-summary human confirmation is needed. A denial stops this publication: if the host permits further tracking, retain it with operation hold, this digest and a bounded redacted diagnostic. Never repeat publish or substitute another route. Then follow the assessment handoff through fresh implementation context; broader restrictions and implementation denial remain stops.',
        };
      }
      if (action.digest !== digest) throw new Error('assessment-summary-publication-stale');
    }
    if (!summary?.publicText) throw new Error('assessment-summary-candidate-required');
    const publication = assessmentSummaryPublication(record, intake, summary);
    const result = await publicResponse({
      publication,
      attempted: Boolean(summary.attempt),
      receipt: summary.receipt,
      reconcileOnly: action.operation === 'reconcile',
      setAttempted: (attempted) => {
        if (attempted) summary!.attempt = randomUUID();
        else delete summary!.attempt;
      },
      setReceipt: (receipt) => {
        summary!.receipt = receipt;
      },
      save: async () => {
        const retained = { revision: summary!.revision, resultDigest: summary!.resultDigest };
        await input.save();
        summary = record.assessmentSummaries?.find(
          (entry) =>
            entry.revision === retained.revision && entry.resultDigest === retained.resultDigest,
        );
        if (!summary) throw new Error('assessment-summary-state-changed');
      },
      dependencies: {
        redactText: input.redact,
        authorize: async () => {
          await input.authorize();
          return { authorized: true };
        },
        connect: async () => {
          const connection = await input.connect();
          if (connection.authorLogin) summary!.authorLogin = connection.authorLogin;
          return connection;
        },
        exclusive: async (_key, run) => run(),
      },
    });
    if (result.status !== 'published')
      throw new Error('assessment-summary-publication-unconfirmed');
    delete summary.code;
    await input.save();
    return {
      status: 'published',
      receipt: summary.receipt,
      destination,
      presentation: input.presentation + '\n\n' + summaryCard(summary),
      instruction:
        'Reproduce this complete presentation in the final answer: preserve the private review, separate public summary and verified publication link. Publication does not mean implementation is complete.',
    };
  } catch (error) {
    if (isFilesystemAccessError(error)) throw error;
    const failure = workflowFailure(error, 'assessment-summary-publication-failed');
    const { code } = failure;
    if (summary) {
      if (!summary.code || !/denied|cancelled/.test(summary.code)) summary.code = code;
      await input.save();
    }
    return {
      status: 'blocked',
      ...failure,
      ...(summary?.diagnostic ? { diagnostic: summary.diagnostic } : {}),
      presentation: [
        input.presentation,
        summary?.publicText && summaryCard(summary),
        publicResponsePresentation({
          kind: 'Assessment summary',
          destination,
          attempted: Boolean(summary?.attempt),
          code,
        }),
      ]
        .filter(Boolean)
        .join('\n\n'),
      instruction:
        summary?.code && /denied|cancelled/.test(summary.code)
          ? 'The private assessment remains recorded. Show this retained summary hold and diagnostic separately from implementation progress. Do not compose, publish, reconcile, retry or use a different publication route for this held operation; supported verified recovery or renewed authorization is required. A summary-specific hold grants no authority and does not prevent independently authorized implementation through fresh native context. Broader restrictions, cancellation, lost authority and implementation denial still stop affected work.'
          : 'The private assessment remains recorded. Show its complete presentation and this summary-delivery diagnostic. For an uncertain write, use summary operation reconcile; for missing authority or skill, restore the configured workflow before retrying. A denial stops the affected operation; preserve it without using another publication route.',
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
