import { feedbackTarget } from './reply-target.ts';
import { selectedOpenClawFeedback } from './openclaw-feedback-input.ts';
import {
  isReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import taskPullRequest from './task-pull-request.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type taskTurnContext from './task-turn-context.ts';

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
  task?: Awaited<ReturnType<typeof taskTurnContext>>,
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
  return {
    appendSystemContext: [
      nativeTaskInstructions('openclaw'),
      task?.instructions,
      task?.feedback?.instructions,
      task
        ? undefined
        : 'Usable task context is unavailable. Refresh it with agent_system_context and {}. The runtime supplies all lookup selectors; do not construct a dispatch request.',
      'Preserve the human-facing quoted cards. Keep machine context and instructions out of authored messages.',
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
        currentTurn: { runId: binding.runId, inputId: binding.inputId },
        stage: source
          ? 'feedback'
          : implementation
            ? 'implementation'
            : available.length && !assessment
              ? 'conversation'
              : 'assessment',
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
                  url: binding.repository ? feedbackTarget(binding.repository, event) : undefined,
                };
              })
            : undefined,
        worktree: record.worktree,
        pullRequest: taskPullRequest(record),
        branch: record.work?.delivery?.binding?.branch,
        ...(task
          ? {
              ...task,
              instructions: undefined,
              feedback: task.feedback && { ...task.feedback, instructions: undefined },
            }
          : {}),
      }),
  };
}
