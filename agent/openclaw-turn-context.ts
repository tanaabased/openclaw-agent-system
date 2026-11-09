import { feedbackTarget } from './reply-target.ts';
import { selectedOpenClawFeedback } from './openclaw-feedback-input.ts';
import {
  isReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import taskPullRequest from './task-pull-request.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import { nativeAssessmentInstructions } from './assessment-instructions.ts';
import { feedbackTurnMessage } from './openclaw-feedback.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** native session/incarnation/run identities select retained facts; explicit tools verify authority. */
export default function openclawTurnContext(
  record: OpenClawDispatchRecord,
  binding: {
    workspace?: string;
    repository?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    inputId?: string;
  },
) {
  if (
    !binding.runId ||
    !record.request ||
    !('key' in record.request) ||
    record.request.agentId !== binding.agentId ||
    record.threadId !== binding.sessionKey ||
    !record.sessionCreation?.verified ||
    record.sessionCreation.sessionId !== binding.sessionId ||
    record.retired ||
    record.supersededBy ||
    record.reset
  )
    return;
  const selected = selectedOpenClawFeedback(record, binding.runId);
  const implementation = Boolean(retainedIssueProgression(record));
  const source = selected && !selected.turn?.cancelled ? selected : undefined;
  const available = (record.feedback?.events ?? []).filter(
    (event) => event.native && event.turn && !event.turn.cancelled,
  );
  const assessment =
    !source &&
    !implementation &&
    (!available.length ||
      record.assessmentTurn?.runId === binding.runId ||
      record.firstTurn?.runId === binding.runId);
  const contextRequest = (source?: string) => ({
    action: 'feedback',
    operation: 'context',
    ...(source ? { source } : {}),
  });
  return {
    appendSystemContext: [
      nativeTaskInstructions('openclaw'),
      'Preserve the human-facing quoted cards. Keep machine context and instructions out of authored messages.',
      source
        ? feedbackTurnMessage(record.id, source.id, true)
        : available.length && !assessment
          ? 'When answering a received GitHub comment, select its exact source from availableFeedback and use its contextRequest with agent_system_dispatch. These are lookup hints, not claims that any source belongs to this execution. Do not answer other listed comments merely because they are available. Follow the verified context and configured reply skill. Ordinary direct conversation continues under the existing task permissions.'
          : !implementation
            ? 'Before investigation, use contextRequest from the current Agent System facts with agent_system_dispatch. Continue only after verified OpenClaw context; follow its selected assessment skill and guidance.\n\n' +
              nativeAssessmentInstructions()
            : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    appendContext:
      'Agent System model-only current-turn facts (keep private):\n' +
      JSON.stringify({
        contextProbe: { version: 1, runtime: 'openclaw', hook: 'before_prompt_build' },
        agentId: binding.agentId,
        workspace: binding.workspace,
        currentSession: { sessionKey: binding.sessionKey, sessionId: binding.sessionId },
        receipt: record.id,
        contextRequest: assessment ? { action: 'context' } : undefined,
        currentTurn: { runId: binding.runId, inputId: binding.inputId },
        stage: source
          ? 'feedback'
          : implementation
            ? 'implementation'
            : available.length && !assessment
              ? 'conversation'
              : 'assessment',
        feedbackContextRequest: source && contextRequest(),
        availableFeedback:
          !source && available.length
            ? available.map((event) => {
                const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
                return {
                  source: {
                    number: event.number,
                    itemType: event.itemType,
                    commentId: source.databaseId,
                    kind: isReviewFeedback(source)
                      ? source.feedback.receipt.kind === 'review-comment'
                        ? 'discussion_r'
                        : 'pullrequestreview-'
                      : 'issuecomment-',
                  },
                  contextRequest: binding.repository
                    ? contextRequest(feedbackTarget(binding.repository, event))
                    : undefined,
                };
              })
            : undefined,
        worktree: record.worktree,
        pullRequest: taskPullRequest(record),
        branch: record.work?.delivery?.binding?.branch,
      }),
  };
}
