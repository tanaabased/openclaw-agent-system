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
    appendSystemContext: [
      nativeTaskInstructions('openclaw'),
      'Preserve the human-facing quoted cards. Keep machine context and instructions out of authored messages.',
      source
        ? feedbackTurnMessage(record.id, source.id, true)
        : feedback?.length
          ? 'The native feedback source is not uniquely verified. Inspect its existing receipt before replying; do not infer a comment mapping from the chat identity or comment prose.'
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
        contextRequest:
          !feedback?.length && !implementation ? { action: 'context', id: record.id } : undefined,
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
