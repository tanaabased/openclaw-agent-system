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
  const implementation = Boolean(retainedIssueProgression(record));
  if (
    !binding.runId ||
    record.feedback?.events.some((event) => event.turn?.runId === binding.runId) ||
    !record.request ||
    !('key' in record.request) ||
    record.request.agentId !== binding.agentId ||
    record.threadId !== binding.sessionKey ||
    !record.sessionCreation?.verified ||
    record.sessionCreation.sessionId !== binding.sessionId ||
    record.retired ||
    record.reset
  )
    return;
  return {
    appendSystemContext: nativeTaskInstructions('openclaw'),
    appendContext:
      'Agent System model-only current-turn facts (keep private):\n' +
      JSON.stringify({
        receipt: record.id,
        currentTurn: { runId: binding.runId, inputId: binding.inputId },
        stage: implementation ? 'implementation' : 'assessment',
        worktree: record.worktree,
        pullRequest: taskPullRequest(record),
        branch: record.work?.delivery?.binding?.branch,
      }),
  };
}
