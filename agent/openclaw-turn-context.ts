import taskPullRequest from './task-pull-request.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** native session/incarnation/run identities select retained facts; explicit tools verify authority. */
export default function openclawTurnContext(
  record: OpenClawDispatchRecord,
  binding: {
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
  const feedback = record.feedback?.events.filter(
    (event) => event.turn?.runId === binding.runId || event.turn?.executionRunId === binding.runId,
  );
  if (feedback?.some((event) => !event.native)) return;
  const implementation = Boolean(retainedIssueProgression(record));
  const candidate = feedback?.length === 1 ? feedback[0] : undefined;
  const source =
    candidate &&
    !candidate.turn!.cancelled &&
    (candidate.turn!.executionRunId ?? candidate.turn!.runId) === binding.runId
      ? candidate
      : undefined;
  return {
    // feedback keeps its current explicit instruction path during the delivery probe.
    appendSystemContext: feedback?.length ? '' : nativeTaskInstructions('openclaw'),
    appendContext:
      'Agent System model-only current-turn facts (keep private):\n' +
      JSON.stringify({
        contextProbe: { version: 1, runtime: 'openclaw', hook: 'before_prompt_build' },
        receipt: record.id,
        currentTurn: { runId: binding.runId, inputId: binding.inputId },
        stage: feedback?.length ? 'feedback' : implementation ? 'implementation' : 'assessment',
        feedbackContextRequest: source && {
          action: 'feedback',
          operation: 'context',
          id: record.id,
          eventId: source.id,
        },
        worktree: record.worktree,
        pullRequest: taskPullRequest(record),
        branch: record.work?.delivery?.binding?.branch,
      }),
  };
}
